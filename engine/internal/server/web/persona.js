// persona.js — v0.26→v0.27 the MULTI-PERSONA system, rebuilt on the
// MASTER PANEL's view stack (the v0.26 Sheet is deleted — see panel.js
// for why: it was dead-on-Android, isInsideUI() never knew it).
//
// USER SPEC (v0.26):
//   "Let's have a chat be able to have multiple personas. So a user can
//    click the personas pill and have a cloud provider style UI overlay
//    pop up displaying a list of all of that chats personas. Every chat
//    comes with our default persona, a user may click to add a new
//    persona, look up from a persona library (later), rename and delete
//    personas too."
//   "the first 'always active' pill may be pressed to open another UI
//    Overlay that shows a list of options — always active / shuffle /
//    active by trigger (key, operator, float value)... Pressing any of
//    the options should change the pills text and color."
//   "an interactable pill that says 'list placeholders' clicking it
//    brings up our reusable UI overlay to show a list of all the
//    placeholders {name}, {model}, {provider}, and any custom
//    placeholders the user creates."
//
// VIEWS (all on the master panel's view stack — panel.js pushView):
//   list          the chat's personas (+ new / library / placeholders)
//   editor        CodeMirror markdown editor + the pill row
//   mode          always active / shuffle / active by trigger picker
//   trigger       the Active-When builder (key · op · value)
//   placeholders  every {key} the chat knows + custom management
//
// DATA: PATCH /api/sessions/{id} {personas: JSON, placeholders: JSON}.
// The engine resolves the ACTIVE persona per turn (trigger > shuffle >
// always; see engine internal/server/personas.go) and substitutes
// {name} {model} {provider} {skills} + custom keys. The PM path mirrors
// this client-side (resolveActive + substituteAll below).
//
// Exposes: window.Persona = { open, DEFAULT_PERSONA, resolveActive,
//                             substituteAll, setData, isOpen, backClose }
(function () {
  'use strict';

  var DEFAULT_PERSONA =
    '## Identity\n' +
    'You are {model} (served via {provider}), chatting inside the Doomalay app on the user\'s own device. ' +
    'Your name in this app is {name}. ' +
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

  // ── state for the open chat ───────────────────────────────────────
  var cur = null;         // { sessionId, name, model, provider }
  var personas = [];      // [{id,name,text,mode,trigger}]
  var placeholders = {};  // {key: value}
  var legacyPersona = ''; // v0.19 single-persona column (fallback)
  var cm = null;          // the open editor's CodeMirror

  var MODES = {
    always:   { label: 'always active',     color: 'var(--ok)',       rgb: 'var(--ok-rgb)' },
    shuffle:  { label: 'shuffle',           color: 'var(--accent-2)', rgb: 'var(--accent-2-rgb)' },
    trigger:  { label: 'active by trigger', color: 'var(--warn)',     rgb: 'var(--warn-rgb)' },
    // v0.28: a real stored state — the single-active rule demotes the
    // previous always persona to this; the user can also switch a
    // persona off on purpose (all-off = the app's default persona).
    inactive: { label: 'off',               color: 'var(--text-3)',   rgb: 'var(--text-3-rgb)' }
  };

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }
  function escAttr(s) { return esc(s).replace(/"/g, '&quot;'); }
  function uid() { return 'p_' + Math.random().toString(36).slice(2, 10); }
  function modeMeta(p) { return MODES[(p && p.mode) || 'always'] || MODES.always; }

  // view() — one place that builds panel views with their onMount wiring.
  function view(title, renderHTML, wire) {
    return {
      title: title,
      render: function () { return renderHTML(); },
      onMount: function (el) { if (wire) wire(el); }
    };
  }

  // PV() — the live master panel (persona views always ride the panel
  // that's hosting the chat that opened them).
  function PV() {
    var c = window.ChatPanel && window.ChatPanel.current();
    return (c && c.panel) || null;
  }

  // ── data load / save ──────────────────────────────────────────────
  function loadSession(sessionId, opts) {
    return fetch('/api/sessions/' + sessionId).then(function (r) { return r.json(); }).then(function (sess) {
      cur = {
        sessionId: sessionId,
        name: (opts && opts.name) || (sess && sess.Title) || 'chat',
        model: (opts && opts.model) || (sess && sess.Model) || '',
        provider: (opts && opts.provider) || (sess && sess.Provider) || ''
      };
      legacyPersona = (sess && sess.Persona) || '';
      personas = [];
      if (sess && sess.Personas) {
        try { personas = JSON.parse(sess.Personas) || []; } catch (e) { personas = []; }
      }
      // v0.26 migration: a legacy single persona → the Default persona;
      // a fresh chat ALWAYS carries the Default persona (user spec:
      // "Every chat comes with our default persona") — an empty text
      // means "the app's built-in default prompt".
      if (!personas.length) {
        personas = [{
          id: 'p_default',
          name: 'Default',
          text: legacyPersona.trim() ? legacyPersona : '',
          mode: 'always'
        }];
      }
      placeholders = {};
      if (sess && sess.Placeholders) {
        try { placeholders = JSON.parse(sess.Placeholders) || {}; } catch (e) { placeholders = {}; }
      }
      personas.forEach(normalize);
      enforceSingleActive(); // v0.28: migrate stored lists to single-active
      return sess;
    });
  }

  function normalize(p) {
    if (!p.id) p.id = uid();
    if (!p.name) p.name = 'Persona';
    if (['always', 'shuffle', 'trigger', 'inactive'].indexOf(p.mode) < 0) p.mode = 'always';
    if (p.mode === 'trigger' && !p.trigger) p.mode = 'always';
  }

  // v0.28 SINGLE-ACTIVE (mirrors the engine's enforceSingleActive): at
  // most ONE persona is ever "always active". Activating one demotes
  // the previous; the client keeps the list honest so the UI shows the
  // same truth the engine resolves from.
  function enforceSingleActive() {
    var seen = false;
    personas.forEach(function (p) {
      if (p.mode === 'always') {
        if (seen) p.mode = 'inactive';
        seen = true;
      }
    });
  }

  function persist() {
    return fetch('/api/sessions/' + cur.sessionId, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        personas: JSON.stringify(personas),
        placeholders: JSON.stringify(placeholders)
      })
    }).then(function () {
      try {
        window.dispatchEvent(new CustomEvent('doomalay:persona-saved', {
          detail: { sessionId: cur.sessionId, personas: personas, placeholders: placeholders }
        }));
      } catch (e) {}
    });
  }

  function findPersona(id) {
    for (var i = 0; i < personas.length; i++) if (personas[i].id === id) return personas[i];
    return null;
  }

  // ── ENTRY: the personas pill ────────────────────────────────────
  function open(sessionId, opts) {
    if (!sessionId) return;
    var panel = PV();
    if (!panel) return;
    panel.pushView(view('personas', function () {
      return '<div class="art-loading">loading personas…</div>';
    }));
    loadSession(sessionId, opts).then(function () {
      panel.replaceView(listView());
    }).catch(function (e) {
      panel.replaceView(view('personas', function () {
        return '<div class="art-loading">could not load the session — ' + esc(String(e.message || e)) + '</div>';
      }));
    });
  }

  // ── THE LIST VIEW ─────────────────────────────────────────────────
  function listView() {
    return view('personas · ' + cur.name, function () {
      var rows = '';
      personas.forEach(function (p) {
        var m = modeMeta(p);
        var sub = p.mode === 'trigger' && p.trigger
          ? 'active when {' + p.trigger.key + '} ' + p.trigger.op + ' ' + p.trigger.value
          : p.mode === 'shuffle' ? 'in the random pool'
          : p.mode === 'inactive' ? 'off — switch on from its editor'
          : 'the persona this chat uses';
        rows +=
          '<button class="pv-row" data-persona="' + escAttr(p.id) + '">' +
            '<span class="pv-row-ico">🎭</span>' +
            '<span class="pv-row-meta">' +
              '<span class="pv-row-title">' + esc(p.name) + '</span>' +
              '<span class="pv-row-sub">' + esc(sub) + '</span>' +
            '</span>' +
            '<span style="flex-shrink:0;font-size:var(--ui-micro-fs);font-weight:700;letter-spacing:0.3px;color:' + m.color + ';background:rgba(' + m.rgb + ',0.12);border:1px solid rgba(' + m.rgb + ',0.35);padding:3px 8px;border-radius:5px">' + esc(m.label) + '</span>' +
            '<span class="pv-row-chev">›</span>' +
          '</button>';
      });
      if (!rows) rows = '<div class="art-loading">no personas yet — add one below</div>';
      return (
        '<p class="pv-hint">Each chat can carry several personas. A satisfied <b>trigger</b> wins, then the single <b>always active</b> persona (activating one demotes the previous — v0.28 rule), then the <b>shuffle</b> pool. All-off runs the app\'s built-in default.</p>' +
        rows +
        '<div class="pv-section-label">add</div>' +
        '<button class="pv-row" data-new-persona="1">' +
          '<span class="pv-row-ico">＋</span>' +
          '<span class="pv-row-meta"><span class="pv-row-title">New persona</span>' +
          '<span class="pv-row-sub">write one from scratch</span></span>' +
        '</button>' +
        '<button class="pv-row" style="opacity:0.55">' +
          '<span class="pv-row-ico">☁</span>' +
          '<span class="pv-row-meta"><span class="pv-row-title">Persona library</span>' +
          '<span class="pv-row-sub">coming soon — picking a free home for it</span></span>' +
        '</button>' +
        '<div class="pv-section-label">chat data</div>' +
        '<button class="pv-row" data-placeholders="1">' +
          '<span class="pv-row-ico" style="font-family:monospace">{ }</span>' +
          '<span class="pv-row-meta"><span class="pv-row-title">Placeholders</span>' +
          '<span class="pv-row-sub">{name} {model} {provider} {skills} + custom keys</span></span>' +
          '<span class="pv-row-chev">›</span>' +
        '</button>'
      );
    }, wireList);
  }

  function wireList(el) {
    el.querySelectorAll('[data-persona]').forEach(function (b) {
      b.addEventListener('click', function () {
        var p = findPersona(b.getAttribute('data-persona'));
        if (p) PV().pushView(editorView(p));
      });
    });
    var np = el.querySelector('[data-new-persona]');
    if (np) np.addEventListener('click', function () {
      // v0.28: new personas start INACTIVE (matches the engine's
      // persona_set spec — activate deliberately from the editor).
      var p = { id: uid(), name: 'Persona ' + (personas.length + 1), text: '', mode: 'inactive' };
      personas.push(p);
      persist().then(function () { PV().pushView(editorView(p)); });
    });
    var ph = el.querySelector('[data-placeholders]');
    if (ph) ph.addEventListener('click', function () {
      PV().pushView(placeholdersView());
    });
  }

  // ── THE EDITOR VIEW ───────────────────────────────────────────────
  // v0.28 (user spec): the activation-mode picker is now FOUR compact
  // pills at the TOP (always / shuffle / trigger / off) instead of a
  // nested view — one tap switches the mode (trigger still opens its
  // builder). "always" demotes the previous always persona (single
  // active), "off" parks this one inactive.
  function editorView(p) {
    return view('persona · ' + p.name, function () {
      function modePill(mode, ico, label) {
        var on = (p.mode || 'always') === mode;
        var m = MODES[mode];
        return '<button class="pe-mode-pill" data-set-mode="' + mode + '"' +
          (on ? ' data-on="1"' : '') +
          ' style="background:rgba(' + m.rgb + ',' + (on ? '0.16' : '0.05') + ');' +
          'border:1px solid rgba(' + m.rgb + ',' + (on ? '0.55' : '0.18') + ');' +
          'color:' + (on ? m.color : 'var(--text-3)') + '">' + ico + ' ' + label + '</button>';
      }
      var trigSub = p.mode === 'trigger' && p.trigger
        ? '{' + p.trigger.key + '} ' + p.trigger.op + ' ' + p.trigger.value : '';
      return (
        '<div class="pe-mode-row">' +
          modePill('always', '●', 'always') +
          modePill('shuffle', '⤨', 'shuffle') +
          modePill('trigger', '⚡', 'trigger') +
          modePill('inactive', '○', 'off') +
        '</div>' +
        (trigSub ? '<p class="pv-hint" style="margin:0 2px 8px">' + esc(trigSub) + ' — tap ⚡ trigger to edit</p>' : '') +
        '<div style="display:flex;gap:7px;margin-bottom:10px;align-items:center">' +
          '<input id="pe-name" class="pv-input" style="flex:1;min-height:40px" value="' + escAttr(p.name) + '" placeholder="persona name" aria-label="Persona name">' +
          '<button id="pe-rename" class="pv-btn" style="display:none;min-height:40px;padding:8px 12px">save</button>' +
          '<button id="pe-ph" class="pv-btn" style="min-height:40px;padding:8px 10px;font-size:var(--ui-micro-fs)">{ } placeholders</button>' +
        '</div>' +
        '<div id="pe-body" style="position:relative;height:42vh;min-height:240px;border:1px solid var(--surface-2);border-radius:10px;overflow:hidden"><div class="art-loading">loading editor…</div></div>' +
        '<div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">' +
          '<button id="pe-save" class="pv-btn pv-btn-primary" style="flex:2;min-width:110px" disabled>save</button>' +
          '<button id="pe-default" class="pv-btn" style="flex:1;min-width:80px">↺ default</button>' +
          '<button id="pe-dl" class="pv-btn" style="flex:1;min-width:70px">⇩ .md</button>' +
          '<button id="pe-del" class="pv-btn" style="flex:1;min-width:80px;color:var(--err);border-color:rgba(var(--err-rgb),0.4)">delete</button>' +
        '</div>' +
        '<p class="pv-hint" style="margin-top:10px">{name}, {model}, {provider}, {skills} and custom keys substitute live on every turn — the persona never goes stale when you switch models or rename the chat.</p>'
      );
    }, function (el) { wireEditor(el, p); });
  }

  function wireEditor(el, p) {
    cm = null;
    var dirty = false;
    var saveBtn = el.querySelector('#pe-save');
    var nameInput = el.querySelector('#pe-name');
    var renameBtn = el.querySelector('#pe-rename');

    function markDirty() {
      dirty = true;
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'save · unsaved'; }
      if (renameBtn) renameBtn.style.display = (nameInput && nameInput.value.trim() !== p.name) ? '' : 'none';
    }
    function markClean() { dirty = false; if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'save'; } }

    // the markdown editor (the artifacts-editor CodeMirror stack)
    ensureCSS('/vendor/editor/codemirror.css')
      .then(function () { return ensureScript('/vendor/editor/codemirror.min.js'); })
      .then(function () { return ensureScript('/vendor/editor/mode-markdown.min.js'); })
      .then(function () {
        var host = el.querySelector('#pe-body');
        if (!host || !window.CodeMirror) return;
        host.innerHTML = '';
        var wrap = document.createElement('div');
        wrap.className = 'art-cm-host';
        host.appendChild(wrap);
        cm = CodeMirror(wrap, {
          value: String(p.text || '').trim() ? p.text : DEFAULT_PERSONA,
          mode: 'markdown', lineNumbers: true, lineWrapping: true,
          theme: 'doomalay', viewportMargin: 60
        });
        cm.on('change', markDirty);
        cm.refresh();
      }).catch(function (e) {
        var host = el.querySelector('#pe-body');
        if (host) host.innerHTML = '<div class="art-loading">editor failed to load — ' + esc(String(e.message || e)) + '</div>';
      });

    if (nameInput) nameInput.addEventListener('input', markDirty);
    if (renameBtn) renameBtn.addEventListener('click', function () {
      var v = (nameInput.value || '').trim();
      if (!v) { toast('give it a name'); return; }
      p.name = v;
      persist().then(function () {
        toast('renamed to ' + v);
        renameBtn.style.display = 'none';
        PV().replaceView(editorView(p)); // refresh title + pills
      });
    });

    // v0.28: THE FOUR MODE PILLS — direct taps, no nested picker.
    // "always" demotes the previous always persona (single active),
    // "trigger" opens the builder, "off" parks this persona inactive.
    el.querySelectorAll('[data-set-mode]').forEach(function (b) {
      b.addEventListener('click', function () {
        var mode = b.getAttribute('data-set-mode');
        p.mode = mode;
        if (mode === 'trigger') { p.trigger = p.trigger || { key: 'messages', op: '>', value: 10 }; }
        // v0.28 SINGLE-ACTIVE, persona_activate semantics: promoting
        // THIS persona to always demotes every other always persona —
        // the tapped one wins, not whichever happens to sit first in
        // the list (order-based enforcement would fight the user's tap).
        if (mode === 'always') {
          personas.forEach(function (o) {
            if (o !== p && o.mode === 'always') o.mode = 'inactive';
          });
        }
        persist().then(function () {
          if (mode === 'trigger') PV().pushView(triggerView(p));
          else PV().replaceView(editorView(p)); // repaint pill states
        });
      });
    });

    // LIST PLACEHOLDERS pill.
    var phBtn = el.querySelector('#pe-ph');
    if (phBtn) phBtn.addEventListener('click', function () {
      PV().pushView(placeholdersView());
    });

    if (saveBtn) saveBtn.addEventListener('click', function () {
      if (!cm) return;
      p.text = cm.getValue().trim() ? cm.getValue() : '';
      saveBtn.textContent = 'saving…';
      persist().then(function () { markClean(); toast('persona saved'); })
        .catch(function () { saveBtn.textContent = 'save · retry?'; saveBtn.disabled = false; });
    });

    var defBtn = el.querySelector('#pe-default');
    if (defBtn) defBtn.addEventListener('click', function () {
      if (cm) { cm.setValue(DEFAULT_PERSONA); markDirty(); }
    });

    var dlBtn = el.querySelector('#pe-dl');
    if (dlBtn) dlBtn.addEventListener('click', function () {
      var text = cm ? cm.getValue() : (p.text || DEFAULT_PERSONA);
      var safe = (p.name || 'persona').replace(/[^a-z0-9_-]+/gi, '-').toLowerCase();
      var blob = new Blob([text], { type: 'text/markdown' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = safe + '.md';
      document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 400);
    });

    var delBtn = el.querySelector('#pe-del');
    if (delBtn) delBtn.addEventListener('click', function () {
      if (personas.length <= 1) { toast('every chat keeps at least one persona'); return; }
      if (delBtn.dataset.armed) {
        personas = personas.filter(function (x) { return x.id !== p.id; });
        persist().then(function () { toast('persona deleted'); PV().popView(); });
      } else {
        delBtn.dataset.armed = '1';
        delBtn.textContent = 'sure?';
        setTimeout(function () { delete delBtn.dataset.armed; delBtn.textContent = 'delete'; }, 2600);
      }
    });
  }

  // (v0.28: THE MODE PICKER VIEW is GONE — the editor's four compact
  // mode pills at the top replaced it. The trigger builder below is
  // still a view; the other modes are one-tap.)

  // ── THE TRIGGER BUILDER (item 8) ─────────────────────────────────
  function triggerView(p) {
    return view('active when…', function () {
      var t = p.trigger || { key: 'messages', op: '>', value: 10 };
      return (
        '<p class="pv-hint">When <b>{key}</b> meets the condition, this persona activates — it overrides always-active and shuffle personas for that turn.</p>' +
        '<div class="pv-section-label">key</div>' +
        '<input id="tr-key" class="pv-input" value="' + escAttr(t.key) + '" placeholder="messages · turns · or a custom key">' +
        '<div class="pv-section-label">is</div>' +
        '<select id="tr-op" class="pv-select">' +
          ['=', '<', '>', '!='].map(function (o) {
            return '<option value="' + o + '"' + (o === t.op ? ' selected' : '') + '>' + o + '</option>';
          }).join('') +
        '</select>' +
        '<div class="pv-section-label">value (number)</div>' +
        '<input id="tr-val" class="pv-input" type="number" step="any" inputmode="decimal" value="' + escAttr(String(t.value)) + '">' +
        '<div style="display:flex;gap:8px;margin-top:16px">' +
          '<button id="tr-save" class="pv-btn pv-btn-primary" style="flex:2">set trigger</button>' +
          '<button id="tr-cancel" class="pv-btn" style="flex:1">cancel</button>' +
        '</div>' +
        '<p class="pv-hint" style="margin-top:12px">Custom keys created under Placeholders work here too — the chat can change their values itself later (that\'s the programmable hook).</p>'
      );
    }, function (el) { wireTrigger(el, p); });
  }

  function wireTrigger(el, p) {
    var cancel = el.querySelector('#tr-cancel');
    if (cancel) cancel.addEventListener('click', function () { PV().popView(); });
    var save = el.querySelector('#tr-save');
    if (save) save.addEventListener('click', function () {
      var key = (el.querySelector('#tr-key').value || '').trim().replace(/[{}]/g, '');
      var op = el.querySelector('#tr-op').value;
      var val = parseFloat(el.querySelector('#tr-val').value);
      if (!key) { toast('give the trigger a key'); return; }
      if (isNaN(val)) { toast('the value must be a number'); return; }
      p.mode = 'trigger';
      p.trigger = { key: key, op: op, value: val };
      persist().then(function () {
        toast('active when {' + key + '} ' + op + ' ' + val);
        // off the builder AND the mode picker (the editor sits below both;
        // a single pop left a stale picker in the stack — the back button
        // then needed an extra press to reach the list).
        PV().popView();
        PV().popView();
        PV().replaceView(editorView(p)); // refresh the editor's pill
      });
    });
  }

  // ── THE PLACEHOLDERS VIEW (item 9) ───────────────────────────────
  function placeholdersView() {
    return view('placeholders', function () {
      function builtin(key, val, sub) {
        return '<div class="pv-row" style="cursor:default">' +
          '<span class="pv-row-meta"><span class="pv-row-title" style="font-family:monospace">{' + esc(key) + '}</span>' +
          '<span class="pv-row-sub">' + esc(sub) + '</span></span>' +
          '<span style="flex-shrink:0;font-size:var(--ui-small-fs) - 0.5px;color:var(--accent-2);font-weight:600;max-width:38%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(val) + '</span>' +
        '</div>';
      }
      var customs = '';
      Object.keys(placeholders).sort().forEach(function (k) {
        customs +=
          '<div class="pv-row" style="cursor:default">' +
            '<span class="pv-row-meta"><span class="pv-row-title" style="font-family:monospace">{' + esc(k) + '}</span>' +
            '<span class="pv-row-sub">custom · usable in personas + triggers</span></span>' +
            '<span style="flex-shrink:0;font-size:calc(var(--ui-small-fs) - 0.5px);color:var(--text-2);max-width:32%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(placeholders[k]) + '</span>' +
            '<button data-del-key="' + escAttr(k) + '" style="background:transparent;border:none;color:var(--err);font-size:15px;cursor:pointer;padding:6px 8px;flex-shrink:0">✕</button>' +
          '</div>';
      });
      if (!customs) customs = '<div class="art-loading" style="padding:14px">no custom placeholders yet</div>';
      return (
        '<p class="pv-hint">These substitute into every persona on every turn. Custom keys also work as trigger values (when they hold numbers).</p>' +
        '<div class="pv-section-label">built-in</div>' +
        builtin('name', cur ? cur.name : '—', 'the chat\'s own name (Scooby, Lippy, Crippy…)') +
        builtin('model', cur ? String(cur.model).split('/').pop() : '—', 'the live model — swaps instantly when you switch') +
        builtin('provider', cur ? (cur.provider || '—') : '—', 'the live provider label') +
        builtin('skills', 'stub', 'inert on purpose for now — will point at skills + MCP servers later') +
        '<div class="pv-section-label">custom</div>' +
        customs +
        '<div style="display:flex;gap:8px;margin-top:4px">' +
          '<input id="ph-key" class="pv-input" style="flex:1" placeholder="key (letters, numbers, _)">' +
          '<input id="ph-val" class="pv-input" style="flex:1" placeholder="value (text or number)">' +
        '</div>' +
        '<button id="ph-add" class="pv-btn pv-btn-primary" style="width:100%;margin-top:8px">＋ add placeholder</button>'
      );
    }, wirePlaceholders);
  }

  function wirePlaceholders(el) {
    var add = el.querySelector('#ph-add');
    if (add) add.addEventListener('click', function () {
      var k = (el.querySelector('#ph-key').value || '').trim().replace(/[{}]/g, '');
      var v = el.querySelector('#ph-val').value;
      if (!k || !/^[A-Za-z0-9_]+$/.test(k)) { toast('keys are letters, numbers and _ only'); return; }
      if (['name', 'model', 'provider', 'skills'].indexOf(k) >= 0) { toast(k + ' is built-in — pick another key'); return; }
      placeholders[k] = v;
      persist().then(function () {
        toast('{' + k + '} added');
        PV().replaceView(placeholdersView());
      });
    });
    el.querySelectorAll('[data-del-key]').forEach(function (b) {
      b.addEventListener('click', function () {
        delete placeholders[b.getAttribute('data-del-key')];
        persist().then(function () { PV().replaceView(placeholdersView()); });
      });
    });
  }

  // ── PM (client-side) activation resolution — mirrors personas.go ──
  // Order: satisfied trigger > always (deterministic) > shuffle pool.
  function resolveActive(list, legacyText, metrics) {
    var specs = (list || []).slice();
    if (!specs.length) return { text: legacyText || '', mode: 'always', name: '' };
    for (var i = 0; i < specs.length; i++) {
      var p = specs[i];
      if (p.mode === 'trigger' && p.trigger) {
        var curv = metricValue(p.trigger.key, metrics);
        if (curv !== null) {
          var v = Number(p.trigger.value);
          var ok = p.trigger.op === '=' ? curv === v :
            p.trigger.op === '<' ? curv < v :
            p.trigger.op === '>' ? curv > v :
            p.trigger.op === '!=' ? curv !== v : false;
          if (ok) return p;
        }
      }
    }
    for (var a = 0; a < specs.length; a++) if (specs[a].mode === 'always') return specs[a];
    var pool = specs.filter(function (p) { return p.mode === 'shuffle'; });
    if (pool.length) return pool[Math.floor(Math.random() * pool.length)];
    // v0.28: an all-inactive list is the user's explicit OFF switch —
    // run the app default, never a stale persona (mirrors the engine).
    if (specs[0].mode === 'inactive') return { text: '', mode: 'always', name: '' };
    return specs[0];
  }
  function metricValue(key, metrics) {
    metrics = metrics || {};
    if (key === 'messages' || key === 'message_count') return metrics.messages || 0;
    if (key === 'turns' || key === 'turn_count') return metrics.turns || 0;
    var v = parseFloat(placeholders[key]);
    return isNaN(v) ? null : v;
  }

  function substituteAll(text, chatName, model, provider) {
    if (!text || text.indexOf('{') < 0) return text || '';
    var m = String(model || '').split('/').pop() || 'an AI assistant';
    var out = String(text)
      .split('{name}').join(chatName || '')
      .split('{model}').join(m)
      .split('{provider}').join(provider || '')
      .split('{skills}').join('(no skills attached yet)');
    Object.keys(placeholders).sort(function (a, b) { return b.length - a.length; }).forEach(function (k) {
      out = out.split('{' + k + '}').join(placeholders[k]);
    });
    return out;
  }

  // ── shared loaders / toast ────────────────────────────────────────
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
  window.addEventListener('resize', function () {
    if (cm && cm.refresh) { try { cm.refresh(); } catch (e) {} }
  });

  var toastTimer = null;
  function toast(msg) {
    var t = document.getElementById('persona-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'persona-toast';
      t.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);' +
        'background:var(--surface-2);color:var(--text-1);border:1px solid var(--border);padding:8px 16px;' +
        'border-radius:10px;font-size:var(--ui-small-fs);z-index:3450;opacity:0;transition:opacity 0.2s;pointer-events:none';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.opacity = '1';
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.style.opacity = '0'; }, 1700);
  }

  // ── public API ────────────────────────────────────────────────────
  window.Persona = {
    open: open,
    close: function () { var p = PV(); if (p) p.closeViews(); },
    backClose: function () { var p = PV(); return p ? p.back() : false; },
    isOpen: function () { var p = PV(); return !!(p && p.viewDepth && p.viewDepth()); },
    DEFAULT_PERSONA: DEFAULT_PERSONA,
    // PM-path composition (chatpanel.js):
    resolveActive: resolveActive,
    substituteAll: substituteAll,
    setData: function (list, legacyText, ph) {
      personas = list || [];
      legacyPersona = legacyText || '';
      placeholders = ph || {};
      personas.forEach(normalize);
    }
  };
})();
