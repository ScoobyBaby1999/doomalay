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

  // v0.48 task 6: the default persona is MODE-AWARE — quick chats get the
  // classic app persona; HF chats get an assistant that knows it lives in
  // a Hugging Face Space Linux sandbox with the full toolchain. Mirrors
  // engine chat.go (defaultPersonaQuick / defaultPersonaHF).
  var DEFAULT_PERSONA_QUICK =
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

  var DEFAULT_PERSONA_HF =
    '## Identity\n' +
    'You are {model} (served via {provider}), the Doomalay assistant running INSIDE a Hugging Face Space — a real Linux sandbox in the cloud, not on the user\'s phone. ' +
    'Your name in this app is {name}. ' +
    'If the user asks which model you are, tell them exactly that — never guess and never claim to be a different model. ' +
    'This identity updates automatically when the user switches your model mid-conversation; trust it over any prior assumption.\n\n' +
    '## Environment — you are on Hugging Face (this chat\'s Space)\n' +
    'You have a REAL Linux sandbox: bash, python, git, Node, and a full build toolchain (gcc/g++, make, cmake, Go, Rust, Java, qemu). ' +
    'You can install packages (pip / npm / apt), write and run real code, and manage this very Space through the HF API — edit your own files (Dockerfile, app, README), manage secrets, read logs, restart. ' +
    'Your workspace is per-chat and may be ephemeral — tell the user to commit or download anything important. ' +
    'The Space sleeps after inactivity; the first message after a nap can take a few minutes while it wakes.\n\n' +
    '## Style\n' +
    'Be direct and concise; lead with the outcome, not the process. ' +
    'Use markdown freely — headings, lists, bold, links and fenced code blocks all render nicely in this app. ' +
    'When a live fact matters and web search is enabled, search rather than guess. ' +
    'When you don\'t know something, say so. ' +
    'Prefer DOING over describing: when the user asks for something the sandbox can answer, actually run it and show the real output.\n\n' +
    '## Tools\n' +
    'When the app\'s tool protocol is active, invoke tools ONLY through the protocol\'s ACTION line format — never as plain text. ' +
    'Chain tools freely — plan, run, read results, then run the next — including parallel commands when they are independent. ' +
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

  // kept for backwards compat: the quick-chat default (what DEFAULT_PERSONA
  // always meant before v0.48)
  var DEFAULT_PERSONA = DEFAULT_PERSONA_QUICK;

  // defaultPersonaFor(mode) — mode-aware default ('hf' → the HF persona).
  function defaultPersonaFor(mode) {
    return mode === 'hf' ? DEFAULT_PERSONA_HF : DEFAULT_PERSONA_QUICK;
  }

  // ── state for the open chat ───────────────────────────────────────
  var cur = null;         // { sessionId, name, model, provider }
  var personas = [];      // [{id,name,text,mode,trigger}]
  var placeholders = {};  // {key: value} — this chat's LOCAL customs
  var globalPlaceholders = {}; // v0.29: engine-wide customs (every chatbot)
  var legacyPersona = ''; // v0.19 single-persona column (fallback)
  var cm = null;          // the open editor's CodeMirror
  // v0.31: the picker's heart badges + hearted-first sort read the
  // engine's local heart list (GET /api/hub/personas/hearted — hub hearts
  // AND non-hub local hearts, newest first).
  var hearted = {};

  // v0.29: the GLOBAL custom placeholders live server-side
  // (GET/PUT/DELETE /api/placeholders — app_settings). Cached here; the
  // PM path reads the same cache so both paths agree on {key} values.
  var globalsFresh = false;
  function loadGlobals() {
    return fetch('/api/placeholders').then(function (r) { return r.json(); }).then(function (d) {
      globalPlaceholders = (d && d.placeholders) || {};
      globalsFresh = true;
      return globalPlaceholders;
    }).catch(function () { return globalPlaceholders; });
  }
  loadGlobals(); // module-load warm (localhost fetch — instant)

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
        provider: (opts && opts.provider) || (sess && sess.Provider) || '',
        // v0.48 task 6: mode-aware default persona (quick vs HF)
        sandbox: (sess && sess.Sandbox) || (opts && opts.sandbox) || 'quick',
        sandboxRepo: (sess && sess.SandboxRepo) || ''
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

  // v0.31: load the hearted-persona ids (best-effort — an older engine
  // without the hub just leaves the map empty).
  function loadHearted() {
    return fetch('/api/hub/personas/hearted')
      .then(function (r) { return r.json(); })
      .then(function (d) {
        hearted = {};
        ((d && d.personas) || []).forEach(function (p) { hearted[p.id] = true; });
      })
      .catch(function () {});
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
      return loadGlobals(); // v0.29: trigger keys + substitution need the globals
    }).then(function () {
      return loadHearted(); // v0.31: badges + hearted-first sort
    }).then(function () {
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
      // v0.31: HEARTED PERSONAS SORT TO TOP (the user spec) — a stable
      // partition on the hearted map keeps the existing order otherwise.
      var ordered = personas.slice().sort(function (a, b) {
        return (hearted[b.id] ? 1 : 0) - (hearted[a.id] ? 1 : 0);
      });
      ordered.forEach(function (p) {
        var m = modeMeta(p);
        var sub = p.mode === 'trigger' && p.trigger
          ? 'active when {' + p.trigger.key + '} ' + p.trigger.op + ' ' + p.trigger.value
          : p.mode === 'shuffle' ? 'in the random pool'
          : p.mode === 'inactive' ? 'off — switch on from its editor'
          : 'the persona this chat uses';
        rows +=
          '<button class="pv-row" style="position:relative" data-persona="' + escAttr(p.id) + '">' +
            '<span class="pv-row-ico">🎭</span>' +
            '<span class="pv-row-meta">' +
              '<span class="pv-row-title">' + esc(p.name) + '</span>' +
              '<span class="pv-row-sub">' + esc(sub) + '</span>' +
            '</span>' +
            '<span style="flex-shrink:0;font-size:var(--ui-micro-fs);font-weight:700;letter-spacing:0.3px;color:' + m.color + ';background:rgba(' + m.rgb + ',0.12);border:1px solid rgba(' + m.rgb + ',0.35);padding:3px 8px;border-radius:5px">' + esc(m.label) + '</span>' +
            '<span class="pv-row-chev">›</span>' +
            '<span class="pp-heart' + (hearted[p.id] ? ' on' : '') + '" data-heart="' + escAttr(p.id) + '" title="endorse this persona">♥</span>' +
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
        '<button class="pv-row" data-hub-library="1">' +
          '<span class="pv-row-ico">◈</span>' +
          '<span class="pv-row-meta"><span class="pv-row-title">Persona library</span>' +
          '<span class="pv-row-sub">the community hub — browse, install, publish</span></span>' +
          '<span class="pv-row-chev">›</span>' +
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
    // v0.31: the heart badges — a tap endorses locally (stopPropagation so
    // the card itself doesn't open the editor); the list re-renders with
    // the hearted persona sorted to the top.
    el.querySelectorAll('[data-heart]').forEach(function (h) {
      h.addEventListener('click', function (e) {
        e.stopPropagation();
        var id = h.getAttribute('data-heart');
        var p = findPersona(id);
        var on = !hearted[id];
        fetch('/api/hub/persona/' + (on ? 'heart' : 'unheart'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: id, name: p ? p.name : '' })
        }).then(function (r) { return r.json(); }).then(function (d) {
          if (!d || d.ok === false) throw new Error((d && d.error) || 'could not reach the hub');
          if (on) hearted[id] = true; else delete hearted[id];
          PV().replaceView(listView());
        }).catch(function (err) { toast(err.message || 'could not reach the hub'); });
      });
    });
    // v0.31: the persona library pill — the hub on its persona tab.
    var hl = el.querySelector('[data-hub-library]');
    if (hl) hl.addEventListener('click', function () {
      if (window.Hub) window.Hub.open('persona');
      else toast('the hub is not available');
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
  // v0.28: four compact mode pills at the top (always / shuffle /
  // trigger / off) — one tap switches the mode (trigger still opens its
  // builder). "always" demotes the previous always persona (single
  // active), "off" parks this one inactive.
  // v0.29 (user spec): the ACTION pills (save / ↺ default / ⇩ .md /
  // delete) moved from BELOW the editor to the top too — a second pill
  // row matching the mode pills' size — and the MD editor fills the
  // rest of the panel (pe-root column, flex-fill body). No more
  // "pills, text block, more pills" sandwich.
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
      function actionPill(id, label, extra) {
        return '<button id="' + id + '" class="pe-mode-pill" ' + (extra || '') + ' style="' +
          'background:var(--surface-1);border:1px solid var(--surface-2);color:var(--text-2)">' + label + '</button>';
      }
      var trigSub = p.mode === 'trigger' && p.trigger
        ? '{' + p.trigger.key + '} ' + p.trigger.op + ' ' + p.trigger.value : '';
      return (
        '<div class="pe-root">' +
        '<div class="pe-mode-row">' +
          modePill('always', '●', 'always') +
          modePill('shuffle', '⤨', 'shuffle') +
          modePill('trigger', '⚡', 'trigger') +
          modePill('inactive', '○', 'off') +
        '</div>' +
        '<div class="pe-action-row">' +
          actionPill('pe-save', 'save', 'disabled') +
          actionPill('pe-default', '↺ default') +
          actionPill('pe-dl', '⇩ .md') +
          actionPill('pe-publish', '⇧ publish') +
          actionPill('pe-del', 'delete', 'style="color:var(--err);border-color:rgba(var(--err-rgb),0.4)"') +
        '</div>' +
        '<div style="display:flex;gap:7px;margin-bottom:10px;align-items:center;flex:none">' +
          '<input id="pe-name" class="pv-input" style="flex:1;min-height:40px" value="' + escAttr(p.name) + '" placeholder="persona name" aria-label="Persona name">' +
          '<button id="pe-rename" class="pv-btn" style="display:none;min-height:40px;padding:8px 12px">save</button>' +
          '<button id="pe-ph" class="pv-btn" style="min-height:40px;padding:8px 10px;font-size:var(--ui-micro-fs)">{ } placeholders</button>' +
        '</div>' +
        (trigSub ? '<p class="pv-hint" style="margin:0 2px 8px;flex:none">' + esc(trigSub) + ' — tap ⚡ trigger to edit</p>' : '') +
        '<div class="pe-body-fill" id="pe-body"><div class="art-loading">loading editor…</div></div>' +
        '</div>'
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
          value: String(p.text || '').trim() ? p.text : defaultPersonaFor(cur && cur.sandbox),
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
        if (mode === 'trigger') { p.trigger = p.trigger || { key: 'messages', op: '>', value: '10' }; }
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
      if (cm) { cm.setValue(defaultPersonaFor(cur && cur.sandbox)); markDirty(); }
    });

    var dlBtn = el.querySelector('#pe-dl');
    if (dlBtn) dlBtn.addEventListener('click', function () {
      var text = cm ? cm.getValue() : (p.text || defaultPersonaFor(cur && cur.sandbox));
      var safe = (p.name || 'persona').replace(/[^a-z0-9_-]+/gi, '-').toLowerCase();
      var blob = new Blob([text], { type: 'text/markdown' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = safe + '.md';
      document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 400);
    });

    // v0.31: THE PUBLISH PILL — hands the persona (name + current text)
    // to the hub publisher; the unsaved editor text is what gets shared.
    var pubBtn = el.querySelector('#pe-publish');
    if (pubBtn) pubBtn.addEventListener('click', function () {
      if (!window.HubPublish) { toast('the hub is not available'); return; }
      var text = cm ? cm.getValue() : (p.text || '');
      window.HubPublish.open('persona', { name: p.name, payload: text });
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

  // ── THE TRIGGER BUILDER (v0.29: fixed key list, not free text) ──
  // User spec: "the key should be a set of the available placeholders,
  // all global placeholders (name, provider, model) + any of the chat's
  // local placeholders" — plus the live metrics (messages / turns) that
  // power the classic "activate after N messages" pattern. The value may
  // be a number or text (the engine compares numerically when both
  // sides parse, else case-insensitive string equality).
  function triggerKeys() {
    var groups = [];
    groups.push({ label: 'built-in globals', keys: [
      { key: 'name', sub: 'the chat\'s own name' },
      { key: 'model', sub: 'the live model' },
      { key: 'provider', sub: 'the live provider label' }
    ]});
    groups.push({ label: 'live metrics', keys: [
      { key: 'messages', sub: 'messages in the model-visible history' },
      { key: 'turns', sub: 'user turns so far' }
    ]});
    var gk = Object.keys(globalPlaceholders).sort();
    if (gk.length) {
      groups.push({ label: 'global placeholders 🌐', keys: gk.map(function (k) {
        return { key: k, sub: 'global · = ' + globalPlaceholders[k] };
      })});
    }
    var lk = Object.keys(placeholders).sort();
    if (lk.length) {
      groups.push({ label: 'this chat\'s placeholders 📍', keys: lk.map(function (k) {
        return { key: k, sub: 'local · = ' + placeholders[k] };
      })});
    }
    return groups;
  }

  function triggerView(p) {
    return view('active when…', function () {
      var t = p.trigger || { key: 'messages', op: '>', value: '10' };
      var groups = triggerKeys();
      var keyOpts = '';
      var known = false;
      groups.forEach(function (g) {
        keyOpts += '<optgroup label="' + escAttr(g.label) + '">';
        g.keys.forEach(function (k) {
          var sel = k.key === t.key;
          if (sel) known = true;
          keyOpts += '<option value="' + escAttr(k.key) + '"' + (sel ? ' selected' : '') + '>' +
            esc(k.key) + ' — ' + esc(k.sub) + '</option>';
        });
        keyOpts += '</optgroup>';
      });
      if (!known && t.key) {
        keyOpts += '<optgroup label="stored key"><option selected value="' + escAttr(t.key) + '">' +
          esc(t.key) + ' (stored)</option></optgroup>';
      }
      return (
        '<p class="pv-hint">When <b>{key}</b> meets the condition, this persona activates — it overrides always-active and shuffle personas for that turn, and its text can use that placeholder\'s value.</p>' +
        '<div class="tr-grid">' +
          '<select id="tr-key" class="pv-select" aria-label="trigger key">' + keyOpts + '</select>' +
          '<select id="tr-op" class="pv-select" aria-label="operator">' +
            ['=', '<', '>', '!='].map(function (o) {
              return '<option value="' + o + '"' + (o === t.op ? ' selected' : '') + '>' + o + '</option>';
            }).join('') +
          '</select>' +
          '<input id="tr-val" class="pv-input" type="text" inputmode="text" value="' + escAttr(String(t.value)) + '" placeholder="number or text">' +
        '</div>' +
        '<p class="pv-hint" style="margin:8px 2px 0">numbers compare numerically (<b>messages &gt; 10</b>); text compares as-is (<b>provider = anthropic</b>). Create more keys under <b>{ } placeholders</b> — global ones work in every chatbot, local ones only here.</p>' +
        '<div style="display:flex;gap:8px;margin-top:16px">' +
          '<button id="tr-save" class="pv-btn pv-btn-primary" style="flex:2">set trigger</button>' +
          '<button id="tr-cancel" class="pv-btn" style="flex:1">cancel</button>' +
        '</div>'
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
      var val = (el.querySelector('#tr-val').value || '').trim();
      if (!key) { toast('pick a key'); return; }
      if (val === '') { toast('give the trigger a value'); return; }
      p.mode = 'trigger';
      p.trigger = { key: key, op: op, value: val }; // v0.29: strings allowed
      persist().then(function () {
        toast('active when {' + key + '} ' + op + ' ' + val);
        PV().popView();
        PV().replaceView(editorView(p)); // refresh the editor's pills
      });
    });
  }

  // ── THE PLACEHOLDERS VIEW (v0.29: global ⇄ local scopes) ────────
  // User spec: "the user goes to placeholders, puts a key and a value
  // and presses add placeholder... They have a new pill next to the add
  // placeholder box that switches between global or local, this
  // determines if this new placeholder is global and works for all
  // chatbots, or local and is only recognised by this one chatbot."
  // Globals persist via /api/placeholders; locals via the session PATCH.
  function placeholdersView() {
    return view('placeholders', function () {
      function builtin(key, val, sub) {
        return '<div class="pv-row" style="cursor:default">' +
          '<span class="pv-row-meta"><span class="pv-row-title" style="font-family:monospace">{' + esc(key) + '}</span>' +
          '<span class="pv-row-sub">' + esc(sub) + '</span></span>' +
          '<span style="flex-shrink:0;font-size:calc(var(--ui-small-fs) - 0.5px);color:var(--accent-2);font-weight:600;max-width:38%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(val) + '</span>' +
        '</div>';
      }
      function customRow(k, v, scope) {
        var badge = scope === 'global'
          ? '<span style="flex-shrink:0;font-size:var(--ui-micro-fs);font-weight:700;color:var(--accent-2);letter-spacing:0.3px">🌐 global</span>'
          : '<span style="flex-shrink:0;font-size:var(--ui-micro-fs);font-weight:700;color:var(--text-3);letter-spacing:0.3px">📍 this chat</span>';
        return '<div class="pv-row" style="cursor:default">' +
          '<span class="pv-row-meta"><span class="pv-row-title" style="font-family:monospace">{' + esc(k) + '}</span>' +
          '<span class="pv-row-sub">' + badge + ' · usable in personas + triggers</span></span>' +
          '<span style="flex-shrink:0;font-size:calc(var(--ui-small-fs) - 0.5px);color:var(--text-2);max-width:28%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(v) + '</span>' +
          '<button data-del-key="' + escAttr(k) + '" data-del-scope="' + scope + '" style="background:transparent;border:none;color:var(--err);font-size:15px;cursor:pointer;padding:6px 8px;flex-shrink:0">✕</button>' +
        '</div>';
      }
      var globals = '';
      Object.keys(globalPlaceholders).sort().forEach(function (k) {
        globals += customRow(k, globalPlaceholders[k], 'global');
      });
      if (!globals) globals = '<div class="art-loading" style="padding:14px">no global placeholders yet</div>';
      var customs = '';
      Object.keys(placeholders).sort().forEach(function (k) {
        customs += customRow(k, placeholders[k], 'local');
      });
      if (!customs) customs = '<div class="art-loading" style="padding:14px">no local placeholders yet</div>';
      return (
        '<p class="pv-hint">These substitute into every persona on every turn. <b>🌐 global</b> keys work for ALL chatbots; <b>📍 local</b> keys only this one. Both feed trigger conditions.</p>' +
        '<div class="pv-section-label">built-in</div>' +
        builtin('name', cur ? cur.name : '—', 'the chat\'s own name (Scooby, Lippy, Crippy…)') +
        builtin('model', cur ? String(cur.model).split('/').pop() : '—', 'the live model — swaps instantly when you switch') +
        builtin('provider', cur ? (cur.provider || '—') : '—', 'the live provider label') +
        builtin('skills', 'stub', 'inert on purpose for now — will point at skills + MCP servers later') +
        '<div class="pv-section-label">global 🌐</div>' +
        globals +
        '<div class="pv-section-label">this chat 📍</div>' +
        customs +
        '<div class="pv-section-label">add</div>' +
        '<div style="display:flex;gap:8px;margin-top:2px">' +
          '<input id="ph-key" class="pv-input" style="flex:1" placeholder="key (letters, numbers, _)">' +
          '<input id="ph-val" class="pv-input" style="flex:1" placeholder="value (text or number)">' +
        '</div>' +
        '<div style="display:flex;gap:8px;margin-top:8px">' +
          '<div class="ph-scope-pill" id="ph-scope">' +
            '<button data-scope="global" data-on="0">🌐 global</button>' +
            '<button data-scope="local" data-on="1">📍 this chat</button>' +
          '</div>' +
          '<button id="ph-add" class="pv-btn pv-btn-primary" style="flex:1">＋ add placeholder</button>' +
        '</div>'
      );
    }, wirePlaceholders);
  }

  function wirePlaceholders(el) {
    // the scope pill (v0.29): global ⇄ local for the NEW key being added
    var scope = 'local';
    el.querySelectorAll('#ph-scope button').forEach(function (b) {
      b.addEventListener('click', function () {
        scope = b.getAttribute('data-scope');
        el.querySelectorAll('#ph-scope button').forEach(function (o) {
          o.setAttribute('data-on', o === b ? '1' : '0');
        });
      });
    });
    var add = el.querySelector('#ph-add');
    if (add) add.addEventListener('click', function () {
      var k = (el.querySelector('#ph-key').value || '').trim().replace(/[{}]/g, '');
      var v = el.querySelector('#ph-val').value;
      if (!k || !/^[A-Za-z0-9_]+$/.test(k)) { toast('keys are letters, numbers and _ only'); return; }
      if (['name', 'model', 'provider', 'skills', 'messages', 'turns'].indexOf(k) >= 0) { toast(k + ' is built-in — pick another key'); return; }
      var done = function () {
        toast('{' + k + '} added — ' + (scope === 'global' ? 'every chatbot' : 'this chat'));
        loadGlobals().then(function () { PV().replaceView(placeholdersView()); });
      };
      if (scope === 'global') {
        fetch('/api/placeholders', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: k, value: v })
        }).then(function (r) {
          if (!r.ok) return r.json().then(function (d) { throw new Error((d && d.error) || ('HTTP ' + r.status)); });
          done();
        }).catch(function (e) { toast(e.message || 'could not save'); });
        return;
      }
      placeholders[k] = v;
      persist().then(done);
    });
    el.querySelectorAll('[data-del-key]').forEach(function (b) {
      b.addEventListener('click', function () {
        var k = b.getAttribute('data-del-key');
        if (b.getAttribute('data-del-scope') === 'global') {
          fetch('/api/placeholders/' + encodeURIComponent(k), { method: 'DELETE' })
            .then(function () { return loadGlobals(); })
            .then(function () { PV().replaceView(placeholdersView()); });
          return;
        }
        delete placeholders[k];
        persist().then(function () { PV().replaceView(placeholdersView()); });
      });
    });
  }

  // ── PM (client-side) activation resolution — mirrors personas.go ──
  // Order: satisfied trigger > always (deterministic) > shuffle pool.
  // v0.29: trigger values are strings; keys resolve from the built-in
  // globals (name/model/provider), the live metrics (messages/turns) and
  // the merged custom placeholders (local wins on collisions). Numbers
  // compare numerically; text compares case-insensitively (= / != only).
  function resolveActive(list, legacyText, metrics, live) {
    var specs = (list || []).slice();
    if (!specs.length) return { text: legacyText || '', mode: 'always', name: '' };
    live = live || {};
    for (var i = 0; i < specs.length; i++) {
      var p = specs[i];
      if (p.mode === 'trigger' && p.trigger) {
        if (triggerMet(p.trigger, metrics, live)) return p;
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

  // the CURRENT value of a trigger key (string) — null when unknown.
  function valueFor(key, metrics, live) {
    metrics = metrics || {}; live = live || {};
    key = String(key || '').trim();
    if (key === 'messages' || key === 'message_count') return String(metrics.messages || 0);
    if (key === 'turns' || key === 'turn_count') return String(metrics.turns || 0);
    if (key === 'name') return live.name || '';
    if (key === 'model') return String(live.model || '').split('/').pop() || '';
    if (key === 'provider') return live.provider || '';
    // custom: local wins over global (mirrors mergedPlaceholders)
    if (Object.prototype.hasOwnProperty.call(placeholders, key)) return String(placeholders[key]);
    if (Object.prototype.hasOwnProperty.call(globalPlaceholders, key)) return String(globalPlaceholders[key]);
    return null;
  }

  function triggerMet(t, metrics, live) {
    var curv = valueFor(t.key, metrics, live);
    if (curv === null || curv === '') return false;
    var want = String(t.value == null ? '' : t.value).trim();
    var cn = parseFloat(curv), wn = parseFloat(want);
    var op = t.op;
    if (!isNaN(cn) && !isNaN(wn) && /^\s*-?[\d.]+\s*$/.test(curv) && /^\s*-?[\d.]+\s*$/.test(want)) {
      if (op === '=' || op === '==') return cn === wn;
      if (op === '<') return cn < wn;
      if (op === '>') return cn > wn;
      if (op === '!=') return cn !== wn;
      if (op === '<=') return cn <= wn;
      if (op === '>=') return cn >= wn;
      return false;
    }
    if (op === '=' || op === '==') return curv.toLowerCase() === want.toLowerCase();
    if (op === '!=') return curv.toLowerCase() !== want.toLowerCase();
    return false; // ordering on text never fires
  }

  function substituteAll(text, chatName, model, provider) {
    if (!text || text.indexOf('{') < 0) return text || '';
    var m = String(model || '').split('/').pop() || 'an AI assistant';
    var merged = {};
    for (var g in globalPlaceholders) merged[g] = globalPlaceholders[g]; // global first
    for (var l in placeholders) merged[l] = placeholders[l];            // local wins
    var out = String(text)
      .split('{name}').join(chatName || '')
      .split('{model}').join(m)
      .split('{provider}').join(provider || '')
      .split('{skills}').join('(no skills attached yet)');
    Object.keys(merged).sort(function (a, b) { return b.length - a.length; }).forEach(function (k) {
      out = out.split('{' + k + '}').join(merged[k]);
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
    DEFAULT_PERSONA_QUICK: DEFAULT_PERSONA_QUICK,
    DEFAULT_PERSONA_HF: DEFAULT_PERSONA_HF,
    defaultPersonaFor: defaultPersonaFor,
    // PM-path composition (chatpanel.js):
    resolveActive: resolveActive,
    substituteAll: substituteAll,
    setData: function (list, legacyText, ph, globals) {
      personas = list || [];
      legacyPersona = legacyText || '';
      placeholders = ph || {};
      if (globals) globalPlaceholders = globals; // v0.29 PM mirror
      if (!globalsFresh) loadGlobals();
      personas.forEach(normalize);
    },
    loadGlobals: loadGlobals
  };
})();
