// hubitem.js — v0.31→v0.44 THE HUB: the item detail panel.
//
// USER SPEC: press a card → a panel rendering the full item —
// a COLLAPSIBLE header showing the PNG/gradient background (the image
// fades 100% → 30% alpha top→bottom via a gradient overlay), title,
// description, tags, favorites, downloads, author; the rest of the
// space = the payload itself (personas: the actual .md text through
// the app's existing markdown formatter; templates: the JSON rendered
// as a formatted code block). TWO FLOATING ICONS at the bottom (a
// small rounded-square box each): download + endorse.
//
// ENDORSEMENT RULE (enforced twice — the engine 400s "download the
// item before endorsing it"): the heart button is DISABLED with a
// "download first" tooltip until this session has downloaded the item
// (window.Hub tracks it; a fresh page starts disabled and the engine
// still guards). Endorse fills the heart + counts +1; a second tap
// un-endorses.
//
// Downloading a PERSONA also imports it into the chat that opened the
// hub (GET session → append {id, name, text, mode:"inactive"} → PATCH
// — the persona_set convention; new personas start inactive).
// v0.44: downloading a TEMPLATE saves it into the local user-template
// library (window.TemplateSheet.saveFromHub → "Yours" in the sheet).
//
// Data: GET /api/hub/{type}/item/{repo}/{id} (repo URL-encoded as ONE
// path segment), POST /api/hub/{type}/download {repo,id},
// POST /api/hub/{type}/endorse|/unendorse {repo,id}.
//
// Exposes: window.HubItem = { open }
(function () {
  'use strict';

  var cur = null; // { panel, type, item, payload, downloaded, hearted, folded }

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
  function toast(msg) {
    if (window.Hub && window.Hub.toast) { window.Hub.toast(msg); return; }
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
    toastTimer = setTimeout(function () { t.style.opacity = '0'; }, 1900);
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
    return view('hub · ' + (cur.item.name || 'item'), function () { return renderHTML(); },
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
        cur.panel.replaceView(buildView());
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

    // the header background: a PNG (image at full opacity at the top
    // fading to ~30% at the bottom — the gradient overlay sits OVER
    // the image), the item's v0.44 design SPEC (the shared gradient
    // system: dir / angle / an optional texture dataURL blended in —
    // legacy rows without dir render exactly as before, the 135°
    // sweep), or the deterministic id gradient.
    var bgStyle = '';
    var d = it.design || {};
    if (d.kind === 'gradient' && d.colors && d.colors.length >= 1) {
      var GU = window.GradientUI;
      if (GU) {
        var css = GU.css({ colors: d.colors, dir: d.dir, angle: d.angle, tex: d.tex });
        if (css.charAt(0) === '#') {
          bgStyle = 'background-color:' + css + ';';  // 1 stop + no tex = a solid
        } else {
          // headFade OVER the gradient; the tex rides as the css bottom
          // layer with blend 'color' (the uikit BLENDED contract)
          bgStyle = 'background-image:' + headFade() + ',' + css + ';' +
            ((d.tex && GU.BLENDED) ? 'background-blend-mode:color;' : '');
        }
      } else {
        // no uikit — the v0.33 render
        bgStyle = (d.colors.length === 1)
          ? 'background-color:' + d.colors[0] + ';'
          : 'background-image:' + headFade() + ',linear-gradient(135deg,' + d.colors.join(',') + ');';
      }
    } else if (d.kind !== 'png') {
      bgStyle = 'background-image:' + (window.Hub && window.Hub.idGradient
        ? window.Hub.idGradient(it.id) : 'none') + ';';
    }

    var chips = (it.tags || []).map(function (t) {
      return '<span class="hi-chip">#' + esc(t) + '</span>';
    }).join('');

    return (
      '<div class="hi-root">' +
        '<div class="hi-head' + (cur.folded ? ' folded' : '') + '" id="hi-head">' +
          '<div class="hi-head-bg" id="hi-head-bg" style="' + bgStyle + '"></div>' +
          '<div class="hi-head-body">' +
            '<div class="hi-title">' + esc(it.name) + '</div>' +
            '<div class="hi-desc">' + esc(it.description || '—') + '</div>' +
            '<div class="hi-meta">by ' + esc(it.author || 'unknown') +
              (it.updatedAt ? ' · updated ' + esc(String(it.updatedAt).slice(0, 10)) : '') + '</div>' +
            (chips ? '<div class="hi-chips">' + chips + '</div>' : '') +
            '<div class="hi-counts">' +
              '<span>♥ ' + (it.hearts || 0) + '</span>' +
              '<span>⤓ ' + (it.downloads || 0) + '</span>' +
            '</div>' +
          '</div>' +
          '<span class="hi-fold-ico">' + (cur.folded ? '▸' : '▾') + '</span>' +
        '</div>' +
        '<div class="hi-body" id="hi-body">' +
          (cur.payload == null ? '<div class="art-loading">loading the payload…</div>' : '') +
        '</div>' +
        '<div class="hi-fabs">' +
          '<button class="hi-fab" id="hi-dl" title="download" aria-label="download">⤓</button>' +
          '<button class="hi-fab' + (cur.hearted ? ' on' : '') + '" id="hi-heart"' +
            (cur.downloaded ? ' title="endorse"' : ' disabled title="download first"') +
            ' aria-label="endorse">' + (cur.hearted ? '♥' : '♡') + '</button>' +
        '</div>' +
      '</div>'
    );
  }

  function headFade() {
    // rgba(var(--surface-1-rgb), 0) → rgba(var(--surface-1-rgb), 0.7):
    // the image shows 100% at the top and ~30% at the bottom.
    return 'linear-gradient(to bottom,rgba(var(--surface-1-rgb),0) 0%,rgba(var(--surface-1-rgb),0.7) 100%)';
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

    // the payload — the app's own markdown pipeline (templates get
    // their JSON pretty-printed into a highlighted code block)
    var body = el.querySelector('#hi-body');
    if (body && cur.payload != null && window.Formatter) {
      var text = String(cur.payload || '');
      if (cur.type === 'template') {
        var pretty = text;
        try { pretty = JSON.stringify(JSON.parse(text), null, 2); } catch (e) {}
        text = '```json\n' + pretty + '\n```';
      }
      try {
        window.Formatter.renderInto(body, text, { mode: 'full' });
      } catch (e) {
        body.textContent = text;
      }
    }

    // the PNG header (probed — onerror keeps the id gradient)
    var it = cur.item;
    var bgEl = el.querySelector('#hi-head-bg');
    if (bgEl && (it.design || {}).kind === 'png') {
      var url = '/api/hub/' + encodeURIComponent(cur.type) + '/png/' +
        encodeURIComponent(it.repo) + '/' + encodeURIComponent(it.id);
      var probe = new Image();
      probe.onload = function () {
        bgEl.style.backgroundImage = headFade() + ',url("' + url + '")';
      };
      probe.onerror = function () {
        bgEl.style.backgroundImage = (window.Hub && window.Hub.idGradient)
          ? window.Hub.idGradient(it.id) : 'none';
      };
      probe.src = url;
    }

    var dl = el.querySelector('#hi-dl');
    if (dl) dl.addEventListener('click', function () { doDownload(); });

    var heart = el.querySelector('#hi-heart');
    if (heart) heart.addEventListener('click', function () {
      if (!cur || heart.disabled) return;
      if (cur.hearted) doUnendorse(); else doEndorse();
    });
  }

  // ── actions ───────────────────────────────────────────────────────
  function doDownload() {
    if (!cur || cur.busy) return;
    cur.busy = true;
    var it = cur.item;
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
        cur.panel.replaceView(buildView());
      })
      .catch(function (e) {
        if (!cur) return;
        cur.busy = false;
        toast(e.message || 'the download failed');
      });
  }

  function doEndorse() {
    if (!cur) return;
    var it = cur.item;
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
        cur.panel.replaceView(buildView());
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
        cur.panel.replaceView(buildView());
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
