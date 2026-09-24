// hubitem.js — v0.31→v0.58 THE HUB: the item detail panel ("lib · name").
//
// USER SPEC (v0.58 pt 7): the detail page is the library's product page —
// "lib · <name>" title, a crisp iPhone-style hero (the art shows through a
// contrast scrim so the text never blends into the gradient), the payload
// flowing straight from the title card, and TWO-TO-THREE big round FABs:
// download (or re-publish EDIT once downloaded — pt 12), heart/endorse, and
// for templates a USE button that applies it to the connected chat (pt 13).
// Transient states ride the footer pill: "downloading…" / "endorsing…"
// (held until done), and endorsing before download pops "download first"
// instead of a dead button (pt 7).
//
// USER SPEC (v0.58 pt 8): template payloads render through the ported
// STAGE TREE (the template sheet's "simplified view" — stages as numbered
// cards) with a [stages | raw] toggle; skills stay markdown, themes stay
// pretty-printed JSON.
//
// ENDORSEMENT RULE (enforced twice — the engine 400s "download the item
// before endorsing it"): the heart button renders LOCKED until the item
// is downloaded; tapping it pops the "download first" footer pill (the
// engine still guards).
//
// Downloading a PERSONA imports it into the connected chat; a TEMPLATE or
// SKILL lands in the local user library (TemplateSheet "Yours"); a THEME
// applies itself immediately (LookIO).
//
// Data: GET /api/hub/{type}/item/{repo}/{id} (now + hearted/downloaded
// booleans so fresh sessions render correct states), POST
// /api/hub/{type}/download {repo,id}, POST /api/hub/{type}/endorse|
// unendorse {repo,id}.
//
// Exposes: window.HubItem = { open }
(function () {
  'use strict';

  var cur = null; // { panel, type, item, payload, downloaded, hearted, folded, busy }

  // v0.58 (pt 8): the template payload view toggle — [stages | raw],
  // remembered per install (stages by default: the formatted view is the
  // point of the port).
  var TPLVIEW_KEY = 'doomalay.hi.tplview.v1';
  function readTplView() {
    try { return localStorage.getItem(TPLVIEW_KEY) === 'raw' ? 'raw' : 'stages'; } catch (e) { return 'stages'; }
  }
  function saveTplView(v) { try { localStorage.setItem(TPLVIEW_KEY, v); } catch (e) {} }

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }
  function escAttr(s) { return esc(s).replace(/"/g, '&quot;'); }

  function PV() {
    var c = window.ChatPanel && window.ChatPanel.current();
    return (c && c.panel) || null;
  }
  function view(title, renderHTML, wire, onClose) {
    return {
      title: title,
      render: function () { return renderHTML(); },
      onMount: function (el) { if (wire) wire(el); },
      onClose: onClose || null
    };
  }

  var toastTimer = null;
  function toast(msg, opts) {
    if (window.Hub && window.Hub.toast) { window.Hub.toast(msg, opts); return; }
    var t = document.getElementById('hubitem-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'hubitem-toast';
      t.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);' +
        'background:var(--surface-2);color:var(--text-1);border:1px solid var(--border);padding:8px 16px;' +
        'border-radius:10px;font-size:var(--ui-small-fs);z-index:3450;opacity:0;transition:opacity 0.2s;pointer-events:none';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.opacity = '1';
    if (toastTimer) clearTimeout(toastTimer);
    if (!(opts && opts.hold)) {
      toastTimer = setTimeout(function () { t.style.opacity = '0'; }, (opts && opts.ms) || 1900);
    }
  }

  function api(method, path, body) {
    var opts = { method: method, headers: {} };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    return fetch(path, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (!r.ok) {
          var e = new Error((d && d.error) || ('HTTP ' + r.status));
          e.status = r.status;
          throw e;
        }
        return d;
      });
    });
  }

  // ── entry ────────────────────────────────────────────────────────
  function open(type, item, opts) {
    var panel = PV();
    if (!panel || !item) return;
    opts = opts || {};
    cur = {
      panel: panel,
      type: type,
      item: item,
      payload: opts.payload != null ? opts.payload : null,
      downloaded: !!(window.Hub && window.Hub.isDownloaded(type, item.repo, item.id)),
      hearted: !!(window.Hub && window.Hub.isHearted(type, item.repo, item.id)),
      folded: false
    };
    panel.pushView(buildView());
    if (cur.payload == null) fetchDetail();
  }

  function buildView() {
    // v0.58 (pt 7): "hub · name" → "lib · name".
    return view('lib · ' + (cur.item.name || 'item'), function () { return renderHTML(); },
      function (el) { wire(el); },
      function () { cur = null; });
  }

  function fetchDetail() {
    if (!cur) return;
    var it = cur.item;
    api('GET', '/api/hub/' + encodeURIComponent(cur.type) + '/item/' +
        encodeURIComponent(it.repo) + '/' + encodeURIComponent(it.id))
      .then(function (d) {
        if (!cur) return;
        cur.item = d.item || cur.item;
        cur.payload = d.payload != null ? d.payload : '';
        // v0.58: the served heart/download booleans seed the session maps —
        // a FRESH page now renders correct endorse/download states.
        if (d.hearted != null && cur.item) {
          cur.hearted = !!d.hearted;
          if (window.Hub) window.Hub.setHearted(cur.type, cur.item.repo, cur.item.id, !!d.hearted);
        }
        if (d.downloaded && cur.item) {
          cur.downloaded = true;
          if (window.Hub) window.Hub.markDownloaded(cur.type, cur.item.repo, cur.item.id);
        }
        cur.panel.replaceView(buildView(), { keepScroll: true });
      })
      .catch(function (e) {
        if (!cur) return;
        toast(e.message || 'the item could not be reached');
      });
  }

  // ── rendering ────────────────────────────────────────────────────
  function renderHTML() {
    if (!cur) return '';
    var it = cur.item;
    var isTpl = cur.type === 'template';

    // the header background: a PNG (fading under the veil), the item's
    // gradient design SPEC, or the deterministic id gradient.
    var bgStyle = '';
    var d = it.design || {};
    if (d.kind === 'gradient' && d.colors && d.colors.length >= 1) {
      var GU = window.GradientUI;
      if (GU) {
        var css = GU.css({ colors: d.colors, dir: d.dir, angle: d.angle, tex: d.tex });
        if (css.charAt(0) === '#') {
          bgStyle = 'background-color:' + css + ';';
        } else {
          bgStyle = 'background-image:' + css + ';';
        }
      } else {
        bgStyle = (d.colors.length === 1)
          ? 'background-color:' + d.colors[0] + ';'
          : 'background-image:linear-gradient(135deg,' + d.colors.join(',') + ');';
      }
    } else if (d.kind !== 'png') {
      bgStyle = 'background-image:' + (window.Hub && window.Hub.idGradient
        ? window.Hub.idGradient(it.id) : 'none') + ';';
    }

    var chips = (it.tags || []).map(function (t) {
      return '<span class="hi-chip">#' + esc(t) + '</span>';
    }).join('');

    var ico = (it.icon && window.IconLib) ? window.IconLib.svg(it.icon, 24) : '';
    var stageN = isTpl && it.stageCount > 0
      ? '<span class="hi-stagen">~' + it.stageCount + ' stages</span>' : '';

    return (
      '<div class="hi-root" data-tone="' + escAttr(cur.type) + '">' +
        '<div class="hi-head' + (cur.folded ? ' folded' : '') + '" id="hi-head">' +
          '<div class="hi-head-bg" id="hi-head-bg" style="' + bgStyle + '"></div>' +
          '<div class="hi-head-scrim" aria-hidden="true"></div>' +
          '<div class="hi-head-body">' +
            '<div class="hi-titlerow">' +
              (ico ? '<span class="hi-ico" aria-hidden="true">' + ico + '</span>' : '') +
              '<div class="hi-title">' + esc(it.name) + '</div>' +
            '</div>' +
            '<div class="hi-desc">' + esc(it.description || '—') + '</div>' +
            '<div class="hi-meta">by ' + esc(it.author || 'unknown') +
              (it.updatedAt ? ' · updated ' + esc(String(it.updatedAt).slice(0, 10)) : '') + '</div>' +
            (chips ? '<div class="hi-chips">' + chips + stageN + '</div>' : '') +
            '<div class="hi-counts">' +
              '<span>' + hiGlyph('heart') + '<b>' + (it.hearts || 0) + '</b></span>' +
              '<span>' + hiGlyph('download') + '<b>' + (it.downloads || 0) + '</b></span>' +
            '</div>' +
          '</div>' +
          '<span class="hi-fold-ico">' + (cur.folded ? '▸' : '▾') + '</span>' +
        '</div>' +
        '<div class="hi-body" id="hi-body">' +
          (cur.payload == null ? '<div class="art-loading">loading the payload…</div>' : '') +
        '</div>' +
        '<div class="hi-fabs">' +
          (isTpl
            ? '<button class="hi-fab hi-fab--use" id="hi-use" title="use this template" aria-label="use this template">' +
                hiGlyph('play') + '</button>'
            : '') +
          '<button class="hi-fab" id="hi-dl" title="' +
            (isTpl && cur.downloaded ? 're-publish with edits' : 'download') +
            '" aria-label="' + (isTpl && cur.downloaded ? 're-publish with edits' : 'download') + '">' +
            (isTpl && cur.downloaded ? hiGlyph('pen-line') : hiGlyph('download')) + '</button>' +
          '<button class="hi-fab hi-fab--heart' + (cur.hearted ? ' on' : '') +
            (cur.downloaded ? '' : ' locked') + '" id="hi-heart"' +
            (cur.downloaded ? ' title="endorse"' : ' title="download first"') +
            ' aria-label="endorse">' + hiGlyph('heart', cur.hearted) + '</button>' +
        '</div>' +
      '</div>'
    );
  }

  // v0.58: the detail glyphs — real IconLib SVGs (the old text ⤓/♥ DOS
  // glyphs are gone), filled hearts when on.
  function hiGlyph(name, filled) {
    var I = window.IconLib;
    if (!I || !I.has(name)) return { heart: '♥', download: '⤓', 'pen-line': '✎', play: '▶' }[name] || '';
    var s = I.svg(name, 26);
    if (filled) s = s.replace('fill="none"', 'fill="currentColor"');
    return s;
  }

  // ── wiring ───────────────────────────────────────────────────────
  function wire(el) {
    if (!cur) return;

    // the collapsible header — a class toggle, no re-render needed
    var head = el.querySelector('#hi-head');
    if (head) head.addEventListener('click', function () {
      head.classList.toggle('folded');
      var ico = head.querySelector('.hi-fold-ico');
      if (ico) ico.textContent = head.classList.contains('folded') ? '▸' : '▾';
    });

    // the payload render: templates → the STAGE TREE or raw (the toggle),
    // skills/personas → markdown, themes → pretty JSON.
    renderPayload(el);

    // the PNG header (probed — onerror keeps the id gradient)
    var it = cur.item;
    var bgEl = el.querySelector('#hi-head-bg');
    if (bgEl && (it.design || {}).kind === 'png') {
      var url = '/api/hub/' + encodeURIComponent(cur.type) + '/png/' +
        encodeURIComponent(it.repo) + '/' + encodeURIComponent(it.id);
      var probe = new Image();
      probe.onload = function () { bgEl.style.backgroundImage = 'url("' + url + '")'; };
      probe.onerror = function () {
        bgEl.style.backgroundImage = (window.Hub && window.Hub.idGradient)
          ? window.Hub.idGradient(it.id) : 'none';
      };
      probe.src = url;
    }

    // v0.58 (pt 13): USE — apply the template to the library's connected
    // chat (erroring "connect a chat first" when unbound).
    var use = el.querySelector('#hi-use');
    if (use) use.addEventListener('click', function () { doUse(); });

    // v0.58 (pt 12): downloaded templates swap ⤓ for the EDIT (re-publish)
    // fab; everything else keeps the plain download.
    var dl = el.querySelector('#hi-dl');
    if (dl) dl.addEventListener('click', function () {
      if (cur.type === 'template' && cur.downloaded && window.HubPublish) { doEdit(); return; }
      doDownload();
    });

    // v0.58 (pt 7): the LOCKED heart still answers a tap — the footer pill
    // explains the download-first rule (the engine 400-guards regardless).
    var heart = el.querySelector('#hi-heart');
    if (heart) heart.addEventListener('click', function () {
      if (!cur) return;
      if (!cur.downloaded) {
        toast('download first — endorsing needs a download', { ms: 2400 });
        return;
      }
      if (cur.hearted) doUnendorse(); else doEndorse();
    });
  }

  // the payload body — mode per type (v0.58 pt 8: templates get the ported
  // stage tree + a raw toggle; skills markdown; themes as before). The
  // toggle is (re)wired here — renderPayload owns everything inside #hi-body.
  function renderPayload(el) {
    var body = el.querySelector('#hi-body');
    if (!body || cur.payload == null) return;
    var text = String(cur.payload || '');
    if (cur.type === 'template') {
      var stages = parseStages(text);
      if (stages && stages.length) {
        var mode = readTplView();
        var seg =
          '<div class="hi-viewrow"><div class="hi-viewseg" role="group" aria-label="payload view">' +
            '<button type="button" data-view="stages"' + (mode === 'stages' ? ' class="on"' : '') + '>stages</button>' +
            '<button type="button" data-view="raw"' + (mode === 'raw' ? ' class="on"' : '') + '>raw</button>' +
          '</div></div>';
        if (mode === 'stages') {
          body.innerHTML = seg + stageTreeHTML(stages);
        } else {
          // renderInto replaces its target — the raw block renders into its
          // own wrapper so the toggle row above survives.
          body.innerHTML = seg + '<div class="hi-rawwrap" id="hi-rawwrap"></div>';
          var wrap = body.querySelector('#hi-rawwrap');
          try { window.Formatter.renderInto(wrap, jsonFence(text), { mode: 'full' }); }
          catch (e) { if (wrap) wrap.textContent = text; }
        }
        var seg2 = body.querySelector('.hi-viewseg');
        if (seg2) seg2.querySelectorAll('[data-view]').forEach(function (b) {
          b.addEventListener('click', function () {
            saveTplView(b.getAttribute('data-view'));
            renderPayload(el);
          });
        });
        return;
      }
    }
    body.innerHTML = '';
    if (cur.type === 'theme') {
      try {
        window.Formatter.renderInto(body, jsonFence(text), { mode: 'full' });
      } catch (e) { body.textContent = text; }
      return;
    }
    // skills + personas: the markdown pipeline (a SKILL.md is markdown)
    try {
      window.Formatter.renderInto(body, text, { mode: 'full' });
    } catch (e) {
      body.textContent = text;
    }
  }

  function jsonFence(text) {
    var pretty = text;
    try { pretty = JSON.stringify(JSON.parse(text), null, 2); } catch (e) {}
    return '```json\n' + pretty + '\n```';
  }

  // v0.58: parse a template payload's stages (same shape the sheet uses).
  function parseStages(text) {
    try {
      var raw = JSON.parse(text);
      if (raw && typeof raw === 'object' && Array.isArray(raw.stages) && raw.stages.length) {
        return raw.stages;
      }
    } catch (e) {}
    return null;
  }

  // v0.58 (pt 8): the ported "simplified view" — the template sheet's stage
  // tree markup (its CSS is global), one numbered card per stage.
  function stageTreeHTML(stages) {
    var out = '<div class="ts-detail-body hi-stages">';
    for (var i = 0; i < stages.length; i++) {
      var st = stages[i] || {};
      var fo = st.fanout && typeof st.fanout === 'object'
        ? '<div class="ts-stage-fo">fan-out over ' + esc(st.fanout.over || 'items') +
          ' · max ' + esc(st.fanout.max_parallel || 1) + ' parallel</div>' : '';
      out += (
        '<div class="ts-stage">' +
          '<div class="ts-stage-head"><span class="ts-stage-n">' + (i + 1) + '</span>' +
            '<span class="ts-stage-name">' + esc(st.name || 'stage ' + (i + 1)) + '</span>' +
            (st.role ? '<span class="ts-chip">' + esc(st.role) + '</span>' : '') +
          '</div>' + fo +
          (st.instructions ? '<div class="ts-stage-ins">' + esc(st.instructions) + '</div>' : '') +
        '</div>'
      );
    }
    return out + '</div>';
  }
  function wireStageTree(body) {
    // future interactivity (expand/collapse per stage) — the tree is
    // static for now, matching the sheet's detail view.
  }

  // ── actions ───────────────────────────────────────────────────────
  function doDownload() {
    if (!cur || cur.busy) return;
    cur.busy = true;
    var it = cur.item;
    toast('downloading…', { hold: true });   // v0.58: the transient footer state
    api('POST', '/api/hub/' + encodeURIComponent(cur.type) + '/download',
        { repo: it.repo, id: it.id })
      .then(function (d) {
        if (!cur) return;
        cur.busy = false;
        cur.item = d.item || cur.item;
        cur.payload = d.payload != null ? d.payload : cur.payload;
        cur.downloaded = true;
        if (window.Hub) window.Hub.markDownloaded(cur.type, it.repo, it.id);
        toast('downloaded — ' + cur.item.name);
        if (window.Hub) window.Hub.refreshItem(cur.item);
        if (cur.type === 'persona') importPersona(cur.item, cur.payload);
        // v0.44 TEMPLATE PILL: a downloaded TEMPLATE lands in the local
        // user-template library (templatesheet.js "Yours") — it is then
        // selectable from the composer's ⧉ template pill like any other.
        // v0.48: downloaded SKILLS join it (a SKILL.md is a usable
        // methodology brief for the turn — the sheet's buildBrief handles
        // markdown payloads).
        if ((cur.type === 'template' || cur.type === 'skill') &&
            window.TemplateSheet && window.TemplateSheet.saveFromHub) {
          window.TemplateSheet.saveFromHub(cur.item, cur.payload);
        }
        // v0.52 THEMES (user spec item 9): a downloaded THEME applies
        // itself right away — a global bundle repaints the whole app
        // (theme, gradients, photos, bump maps — the works); a chat
        // bundle lands in the open chatbot. The magic-field validation
        // inside LookIO keeps a malformed payload harmless.
        if (cur.type === 'theme' && window.LookIO && window.LookIO.importText) {
          window.LookIO.importText(cur.payload);
        }
        cur.panel.replaceView(buildView(), { keepScroll: true });
      })
      .catch(function (e) {
        if (!cur) return;
        cur.busy = false;
        toast(e.message || 'the download failed');
      });
  }

  // v0.58 (pt 12): EDIT — re-publish a downloaded template. The publish
  // form arrives pre-filled (info + card visuals + payload) and refuses an
  // unedited re-publish (HubPublish's dirty guard).
  function doEdit() {
    if (!cur || !window.HubPublish) return;
    var it = cur.item;
    window.HubPublish.open('template', {
      name: it.name || '',
      desc: it.description || '',
      tags: (it.tags || []).slice(),
      icon: it.icon || '',
      design: it.design || null,
      payload: cur.payload != null ? cur.payload : '',
      stageCount: it.stageCount || 0,
      collection: it.collection || '',
      editOf: { type: 'template', repo: it.repo, id: it.id, name: it.name }
    });
  }

  // v0.58 (pt 13): USE — apply the template to the library's connected
  // chat. The engine's deep-research builtin flips the deepResearch flag
  // (the real pipeline); every other template applies its methodology brief.
  function doUse() {
    if (!cur) return;
    var chat = window.Hub && window.Hub.chat ? window.Hub.chat() : null;
    if (!chat) { toast('connect a chat first — tap the chat pill', { ms: 2400 }); return; }
    var it = cur.item;
    var tpl = null;
    if (it.repo === 'doomalay/builtin' && it.id === 'deep-research') {
      tpl = { id: 'deep-research', name: 'deep research', deepResearch: true, brief: '' };
    } else if (window.TemplateSheet && window.TemplateSheet.normalizeHubPayload) {
      var entry = window.TemplateSheet.normalizeHubPayload(it, cur.payload);
      if (entry) {
        tpl = { id: entry.id, name: entry.name, brief: window.TemplateSheet.buildBrief(entry) };
      }
    }
    if (!tpl || !(tpl.brief || tpl.deepResearch)) { toast('this template has no usable body'); return; }
    if (window.ChatPanel && window.ChatPanel.applyTemplate) {
      window.ChatPanel.applyTemplate(tpl);
      toast('template applied — ' + tpl.name);
    } else {
      toast('no chat panel to apply it to');
    }
  }

  function doEndorse() {
    if (!cur) return;
    var it = cur.item;
    toast('endorsing…', { hold: true });      // v0.58: the transient footer state
    api('POST', '/api/hub/' + encodeURIComponent(cur.type) + '/endorse',
        { repo: it.repo, id: it.id })
      .then(function (d) {
        if (!cur) return;
        cur.hearted = true;
        cur.item = d.item || cur.item;
        if (window.Hub) {
          window.Hub.setHearted(cur.type, it.repo, it.id, true);
          window.Hub.refreshItem(cur.item);
        }
        toast('endorsed ♥');
        cur.panel.replaceView(buildView(), { keepScroll: true });
      })
      .catch(function (e) {
        toast(e.message || 'could not endorse');
      });
  }

  function doUnendorse() {
    if (!cur) return;
    var it = cur.item;
    api('POST', '/api/hub/' + encodeURIComponent(cur.type) + '/unendorse',
        { repo: it.repo, id: it.id })
      .then(function (d) {
        if (!cur) return;
        cur.hearted = false;
        cur.item = d.item || cur.item;
        if (window.Hub) {
          window.Hub.setHearted(cur.type, it.repo, it.id, false);
          window.Hub.refreshItem(cur.item);
        }
        toast('endorsement removed');
        cur.panel.replaceView(buildView(), { keepScroll: true });
      })
      .catch(function (e) {
        toast(e.message || 'could not un-endorse');
      });
  }

  // Import a downloaded persona into the chat that opened the hub:
  // GET the session → parse its personas JSON column → append (inactive,
  // the persona_set convention) → PATCH back. The PATCH only carries
  // the personas key, so nothing else on the row is touched.
  function importPersona(item, payload) {
    var c = window.ChatPanel && window.ChatPanel.current();
    if (!c || !c.state) return;
    var state = c.state;
    var go = function () {
      if (!state.sessionId) return;
      fetch('/api/sessions/' + state.sessionId)
        .then(function (r) { return r.json(); })
        .then(function (sess) {
          var list = [];
          try { list = JSON.parse((sess && sess.Personas) || '[]') || []; } catch (e) { list = []; }
          // a fresh chat's stored list is EMPTY — the Default persona is
          // synthesized client-side (persona.js loadSession). Mirror that
          // here so importing into a fresh chat doesn't drop the Default.
          if (!list.length) {
            list = [{ id: 'p_default', name: 'Default', text: (sess && sess.Persona) || '', mode: 'always' }];
          }
          for (var i = 0; i < list.length; i++) {
            if (list[i].id === item.id) return; // already imported
          }
          list.push({ id: item.id, name: item.name, text: payload || '', mode: 'inactive' });
          return fetch('/api/sessions/' + state.sessionId, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ personas: JSON.stringify(list) })
          });
        })
        .then(function (r) {
          if (r && r.ok) toast('added to this chat\'s personas — switch it on from its editor');
        })
        .catch(function () { toast('saved locally, but the chat import failed'); });
    };
    if (state.sessionId) return go();
    if (window.ChatPanel.ensureSession) window.ChatPanel.ensureSession(state, go);
  }

  window.HubItem = { open: open };
})();
