// templatesheet.js — v0.44 THE TEMPLATE PILL's SHEET (the method-template
// library browser).
//
// USER SPEC (v0.44, the pill redesign): "change the deep research pill
// entirely to a template pill where user can select templates and browse
// the library, with the deep research being one of the default
// templates… The template pill should have a favorites, method to
// endorse, method to browse, method to download and publish templates."
//
// This module is the BROWSE half: a master-panel view (panel.js pushView
// — the house pattern hub.js / persona.js / modelbrowser.js all use) with
//   - a search input that NEVER re-renders while typing (the hub rule:
//     only the list zone repaints, so the keyboard survives)
//   - grouped rows: ⭐ Favorites first, then Deep research (the engine's
//     native pipeline pinned on top) / Superpowers flows / Flows / Yours
//   - one row per template: name + one-line description + task_type chip
//     + the star toggle (favorites: localStorage
//     doomalay.template.favs.v1)
//   - tap a row → the detail view: the stage tree or the markdown body
//     (through the shared Formatter) + "⧉ use this template"
//   - ⟳ refresh (re-fetch), ⌂ hub library (window.Hub.open('template') —
//     the community library: endorse ♥ / download / publish live THERE),
//     ⤴ publish (HubPublish prefilled as type template)
//
// ACTIVATION: the sheet resolves the brief (stages → numbered step
// instructions, markdown → the body) and hands {id, name, brief} to the
// host's onActivate callback (chatpanel.js sets state.template, persists
// the caps, and repaints the pill + the composer chip). The pinned
// "deep research" row activates the ENGINE-native pipeline instead
// (state.deepResearch — exactly the old pill's payload flow).
//
// "Yours": templates downloaded from the hub (hubitem.js calls
// TemplateSheet.saveFromHub on download) live in localStorage
// doomalay.user.templates.v1 and appear here with kind "user".
//
// Exposes: window.TemplateSheet = { open, saveFromHub, buildBrief }
(function () {
  'use strict';

  var FAV_KEY = 'doomalay.template.favs.v1';
  var USER_KEY = 'doomalay.user.templates.v1';
  var BRIEF_CAP = 24000; // spawn-prompt tolerance, not infinity (dt's rule)

  // the pinned engine-native row (deep research is "one of the default
  // templates" per the user spec — its payload is the old deep_research
  // flag, handled by the host, never a brief)
  var DEEP_RESEARCH_ROW = {
    id: 'deep-research',
    kind: 'engine',
    name: 'Deep research',
    task_type: 'deep_research',
    description: "The app's built-in engine pipeline: multi-round live web search, fetch and read the sources, plan the gaps, synthesize a fully-cited report.",
    stage_count: 0,
    stages: [],
    markdown: '',
    tags: ['research', 'citations', 'web'],
    pinned: true
  };

  var cur = null; // { panel, q, items, user, favs, loading, err, activeId, onActivate }

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
    var t = document.getElementById('ts-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'ts-toast';
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

  // ── localStorage (favorites + user templates) ──────────────────────
  function readJSON(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) || fallback; }
    catch (e) { return fallback; }
  }
  function writeJSON(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
  }
  function readFavs() { return readJSON(FAV_KEY, []); }
  function writeFavs(f) { writeJSON(FAV_KEY, f); }
  function isFav(id) { return readFavs().indexOf(id) >= 0; }
  function toggleFav(id) {
    var f = readFavs();
    var i = f.indexOf(id);
    if (i >= 0) f.splice(i, 1); else f.push(id);
    writeFavs(f);
    return i < 0;
  }
  function readUserTemplates() { return readJSON(USER_KEY, []); }

  // v0.48: only localStorage copies are removable from the sheet —
  // engine-merged hub rows (source 'hub' but not in the store) have no
  // local copy to remove; the button would be a lying no-op.
  function inUserStore(id) {
    var list = readUserTemplates();
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].id === id) return true;
    }
    return false;
  }

  // saveFromHub — a hub download lands here (hubitem.js type=template).
  // payload is the template JSON (or markdown). Stored entries carry the
  // same shape as the brain index so the sheet treats them identically.
  function saveFromHub(item, payload) {
    var entry = normalizeHubPayload(item, payload);
    if (!entry) { toast('that item did not carry a usable template'); return null; }
    var list = readUserTemplates();
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === entry.id) { list[i] = entry; break; }
    }
    if (i >= list.length) list.push(entry);
    writeJSON(USER_KEY, list);
    toast('saved to your templates — find it under "Yours"');
    return entry;
  }

  function normalizeHubPayload(item, payload) {
    item = item || {};
    var text = String(payload == null ? '' : payload);
    var raw = null;
    try { raw = JSON.parse(text); } catch (e) { raw = null; }
    if (raw && typeof raw === 'object' && !Array.isArray(raw) &&
        (raw.name || raw.stages || raw.markdown)) {
      var stages = Array.isArray(raw.stages) ? raw.stages : [];
      return {
        id: String(raw.id || item.id || slug(item.name || 'template')),
        kind: 'user',
        name: String(raw.name || item.name || 'Template'),
        task_type: String(raw.task_type || ''),
        description: String(raw.description || item.description || ''),
        stage_count: stages.length,
        stages: stages,
        markdown: String(raw.markdown || ''),
        tags: Array.isArray(raw.tags) ? raw.tags : [],
        source: 'hub'
      };
    }
    // markdown body (or plain text) — publish prefill sends raw text too
    if (text.trim()) {
      return {
        id: String(item.id || slug(item.name || 'template')),
        kind: 'user',
        name: String(item.name || 'Template'),
        task_type: '',
        description: String(item.description || ''),
        stage_count: 0,
        stages: [],
        markdown: text,
        tags: [],
        source: 'hub'
      };
    }
    return null;
  }

  function slug(name) {
    return String(name || '').toLowerCase()
      .replace(/[^0-9a-z]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'template';
  }

  function removeUserTemplate(id) {
    var list = readUserTemplates();
    var out = [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].id !== id) out.push(list[i]);
    }
    writeJSON(USER_KEY, out);
  }

  // ── grouping (mirrors brain dt_template's categorize heuristic) ─────
  var GROUPS = ['Deep research', 'Superpowers flows', 'Flows', 'Yours'];
  function categorize(e) {
    var parts = [e.id, e.name, e.task_type, (e.tags || []).join(' ')];
    var hay = String(parts.join(' ')).toLowerCase().replace(/[_\-]+/g, ' ');
    if (e.kind === 'engine' || e.id === 'deep-research') return 'Deep research';
    if ((e.kind === 'user' || e.kind === 'skill') && e.source === 'hub') return 'Yours';
    if (hay.indexOf('superpower') >= 0) return 'Superpowers flows';
    if (hay.indexOf('research') >= 0 || hay.indexOf('paper') >= 0 ||
        hay.indexOf('lesson') >= 0 || hay.indexOf('deep') >= 0 ||
        hay.indexOf('fact check') >= 0 || hay.indexOf('factcheck') >= 0 ||
        hay.indexOf('compare') >= 0 || hay.indexOf('design') >= 0 ||
        hay.indexOf('summary') >= 0) return 'Deep research';
    return 'Flows';
  }

  // ── the brief (the resolved methodology the chat turn receives) ─────
  function buildBrief(entry) {
    if (!entry) return '';
    var out = String(entry.description || '').trim();
    if (out) out += '\n\n';
    var stages = entry.stages || [];
    if (stages.length) {
      out += 'Methodology — work through these stages in order:\n';
      for (var i = 0; i < stages.length; i++) {
        var st = stages[i] || {};
        var line = (i + 1) + '. ' + (st.name || 'stage ' + (i + 1));
        if (st.role) line += ' [' + st.role + ']';
        if (st.instructions) line += ': ' + st.instructions;
        var fo = st.fanout;
        if (fo && typeof fo === 'object') {
          line += ' (fan-out over ' + (fo.over || 'items') + ', max ' +
            (fo.max_parallel || 1) + ' parallel)';
        }
        out += line + '\n';
      }
    } else if (entry.markdown) {
      out += String(entry.markdown).trim() + '\n';
    } else if (!out) {
      out = String(entry.name || 'template') + '\n';
    }
    if (out.length > BRIEF_CAP) out = out.slice(0, BRIEF_CAP) + '\n…[trimmed]';
    return out;
  }

  // ── entry point ─────────────────────────────────────────────────────
  // opts: { active: '<templateId>' | '' , onActivate: function (tpl) }
  // tpl = { id, name, brief } for library templates, or
  //       { id: 'deep-research', deepResearch: true, name: 'deep research' }
  function open(opts) {
    var panel = PV();
    if (!panel) { toast('open a chat first'); return; }
    opts = opts || {};
    cur = {
      panel: panel,
      q: '',
      items: null,        // brain library (null = not fetched yet)
      user: readUserTemplates(),
      loading: false,
      err: '',
      activeId: String(opts.active || ''),
      onActivate: typeof opts.onActivate === 'function' ? opts.onActivate : null
    };
    panel.pushView(buildView());
    fetchLibrary();
  }

  function buildView() {
    return view('templates', function () { return renderHTML(); },
      function (el) { wire(el); },
      function () { cur = null; });
  }

  function fetchLibrary() {
    if (!cur || cur.loading) return;
    cur.loading = true;
    updateList();
    // v0.48: the sheet is three libraries in one — the brain's templates
    // plus the hub's downloaded templates AND skills (engine hub_items:
    // they follow the account across devices and reinstalls, unlike the
    // localStorage "Yours" copy which is per-browser).
    Promise.all([
      fetch('/api/templates').then(function (r) { return r.json(); }),
      hubDownloads('template'),
      hubDownloads('skill')
    ]).then(function (res) {
      if (!cur) return;
      cur.loading = false;
      var tpls = (res[0] && res[0].templates) || [];
      // tolerate the OLD brain shape (raw DEFAULT_TEMPLATES: no id) by
      // deriving id = task_type — the engine proxy is always the new
      // brain, but a stale APK brain keeps the sheet alive.
      for (var i = 0; i < tpls.length; i++) {
        if (!tpls[i].id) tpls[i].id = String(tpls[i].task_type || slug(tpls[i].name));
        if (!tpls[i].kind) tpls[i].kind = 'flow';
      }
      if (!tpls.length) cur.err = 'unavailable'; // brain down — soft notice, rows below still render
      mergeHubDownloads(tpls, (res[1] && res[1].items) || [], (res[2] && res[2].items) || []);
      cur.items = tpls;
      updateList();
    }).catch(function (e) {
      if (!cur) return;
      cur.loading = false;
      cur.err = (e && e.message) || 'the library could not be reached';
      updateList();
    });
  }

  function hubDownloads(type) {
    return fetch('/api/hub/' + type + '/downloads')
      .then(function (r) { return r.json(); })
      .catch(function () { return { items: [] }; }); // offline / old engine — the sheet still works
  }

  // mergeHubDownloads appends the engine-stored hub downloads (templates
  // and skills) to the brain list, deduping against the brain entries and
  // the localStorage "Yours" copies (which stay authoritative — they are
  // the user-editable ones).
  function mergeHubDownloads(tpls, hubRows, skillRows) {
    var have = {};
    for (var i = 0; i < tpls.length; i++) have[tpls[i].id] = 1;
    var mine = readUserTemplates();
    for (var u = 0; u < mine.length; u++) have[mine[u].id] = 1;
    function add(rows, kind) {
      for (var r = 0; r < rows.length; r++) {
        var entry = normalizeHubPayload(rows[r].item, rows[r].payload);
        if (!entry || have[entry.id]) continue;
        entry.kind = kind;
        entry.source = 'hub';
        have[entry.id] = 1;
        tpls.push(entry);
      }
    }
    add(hubRows, 'user');
    add(skillRows, 'skill');
  }

  // ── rendering ───────────────────────────────────────────────────────
  function renderHTML() {
    return (
      '<div class="ts-root" id="ts-root">' +
        '<p class="pv-hint">method templates — pick a discipline for this chat\'s next turns. ⧉ marks it on the composer; deep research rides the engine\'s own pipeline.</p>' +
        '<input id="ts-search" class="pv-input" placeholder="Search templates…" autocomplete="off" spellcheck="false" aria-label="Search templates">' +
        '<div class="ts-actions" role="toolbar" aria-label="Template library actions">' +
          '<button id="ts-refresh" class="ts-act" title="Re-fetch the template library">⟳ refresh</button>' +
          '<button id="ts-hub" class="ts-act" title="Browse the community hub library">⌂ hub library</button>' +
          '<button id="ts-publish" class="ts-act" title="Publish a template to the hub">⤴ publish</button>' +
        '</div>' +
        '<div id="ts-list" class="ts-list" aria-live="polite"></div>' +
      '</div>'
    );
  }

  function wire(el) {
    var searchTimer = null;
    var si = el.querySelector('#ts-search');
    if (si) {
      si.addEventListener('input', function () {
        if (searchTimer) clearTimeout(searchTimer);
        searchTimer = setTimeout(function () {
          if (!cur) return;
          cur.q = si.value;
          updateList();
        }, 180);
      });
    }
    var rf = el.querySelector('#ts-refresh');
    if (rf) rf.addEventListener('click', function () { fetchLibrary(); });
    var hb = el.querySelector('#ts-hub');
    if (hb) hb.addEventListener('click', function () {
      if (window.Hub) window.Hub.open('template');
      else toast('the hub is not available');
    });
    var pb = el.querySelector('#ts-publish');
    if (pb) pb.addEventListener('click', function () { publishTemplate(activeEntry()); });
  }

  // the ACTIVE entry object (for publish prefill) — from the chat's
  // activeId, matched against everything we know.
  function activeEntry() {
    if (!cur || !cur.activeId) return null;
    var all = allEntries();
    for (var i = 0; i < all.length; i++) {
      if (all[i].id === cur.activeId) return all[i];
    }
    return null;
  }

  function allEntries() {
    var items = (cur && cur.items) || [];
    var user = (cur && cur.user) || [];
    var out = [DEEP_RESEARCH_ROW];
    for (var i = 0; i < items.length; i++) out.push(items[i]);
    for (var j = 0; j < user.length; j++) {
      if (user[j] && user[j].id !== 'deep-research') out.push(user[j]);
    }
    return out;
  }

  // ONLY the list zone re-renders (the search input + buttons never do —
  // focus and the mobile keyboard survive, the hub.js rule).
  function updateList() {
    if (!cur || !cur.panel) return;
    var zone = cur.panel.bodyEl.querySelector('#ts-list');
    if (!zone) return;
    var tmp = document.createElement('div');
    tmp.innerHTML = listHTML();
    while (zone.firstChild) zone.removeChild(zone.firstChild);
    while (tmp.firstChild) zone.appendChild(tmp.firstChild);
    wireRows(zone);
  }

  function matches(e, q) {
    if (!q) return true;
    var hay = [e.name, e.description, e.task_type, (e.tags || []).join(' ')].join(' ').toLowerCase();
    return hay.indexOf(q) >= 0;
  }

  function listHTML() {
    if (!cur) return '';
    var all = allEntries();
    var q = String(cur.q || '').toLowerCase().trim();
    var favs = readFavs();

    var groups = {};
    var order = ['Favorites'].concat(GROUPS);
    var filtered = [];
    for (var i = 0; i < all.length; i++) {
      if (matches(all[i], q)) filtered.push(all[i]);
    }

    // loading / empty / error states (honest — never fake rows).
    // v0.48: a brain outage is a NOTICE, not a dead end — the pinned
    // deep-research row, "Yours" and hub downloads still render below it
    // (the user's rule: the app always comes with deep research).
    if (cur.loading) {
      return '<div class="ts-empty">loading the template library…</div>';
    }
    var notice = '';
    if (cur.err) {
      if (!filtered.length && !cur.q) {
        return (
          '<div class="ts-empty">' +
            '<div class="ts-empty-title">template library unavailable</div>' +
            '<div class="ts-empty-sub">the brain service is not running (or returned nothing) — start it and tap ⟳ refresh. ' +
            'Downloaded templates ("Yours") still work, and the hub library can be browsed with ⌂.</div>' +
            '<div class="ts-empty-actions">' +
              '<button class="ts-act" data-act="refresh">⟳ retry</button>' +
              '<button class="ts-act" data-act="hub">⌂ hub library</button>' +
            '</div>' +
          '</div>'
        );
      }
      if (filtered.length) {
        notice = '<div class="ts-notice">⚠ the brain library is unreachable — the built-in rows, your templates and your hub downloads still work. ' +
          '<button class="ts-act" data-act="refresh">⟳ retry</button></div>';
      }
    }
    if (!filtered.length) {
      return '<div class="ts-empty">no templates match "' + esc(cur.q) + '"</div>';
    }

    for (var j = 0; j < filtered.length; j++) {
      var e = filtered[j];
      var g = isFav(e.id) ? 'Favorites' : categorize(e);
      if (!groups[g]) groups[g] = [];
      groups[g].push(e);
    }

    var out = '';
    for (var k = 0; k < order.length; k++) {
      var name = order[k];
      var rows = groups[name];
      if (!rows || !rows.length) continue;
      var label = name === 'Favorites' ? '⭐ favorites' : name;
      out += '<div class="ts-group">' + esc(label) +
        ' <span class="ts-group-n">' + rows.length + '</span></div>';
      for (var r = 0; r < rows.length; r++) out += rowHTML(rows[r]);
    }
    return notice + out;
  }

  function rowHTML(e) {
    var active = cur.activeId === e.id;
    var desc = oneLine(e.description || e.task_type || '');
    var chip = e.task_type && e.task_type !== e.id
      ? '<span class="ts-chip">' + esc(e.task_type) + '</span>' : '';
    var n = e.stage_count || (e.stages || []).length;
    var meta = n ? '<span class="ts-meta">' + n + ' stages</span>'
      : (e.markdown ? '<span class="ts-meta">markdown</span>' : '');
    return (
      '<div class="ts-row' + (active ? ' ts-row-on' : '') + '" data-tpl="' + escAttr(e.id) + '" role="button" tabindex="0">' +
        '<button class="ts-star' + (isFav(e.id) ? ' ts-star-on' : '') + '" data-star="' + escAttr(e.id) + '"' +
          ' title="Favorite" aria-label="Toggle favorite" aria-pressed="' + (isFav(e.id) ? 'true' : 'false') + '">★</button>' +
        '<div class="ts-row-main">' +
          '<div class="ts-row-name">' + (active ? '<span class="ts-on-ico">⧉</span> ' : '') + esc(e.name) + '</div>' +
          '<div class="ts-row-desc">' + esc(desc) + '</div>' +
        '</div>' +
        '<div class="ts-row-side">' + chip + meta + '</div>' +
      '</div>'
    );
  }

  function wireRows(zone) {
    if (!zone || !cur) return;
    zone.querySelectorAll('[data-star]').forEach(function (b) {
      b.addEventListener('click', function (ev) {
        ev.stopPropagation();
        var on = toggleFav(b.getAttribute('data-star'));
        b.classList.toggle('ts-star-on', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
        updateList(); // re-group (favorites move to the top group)
      });
    });
    zone.querySelectorAll('[data-act]').forEach(function (b) {
      b.addEventListener('click', function () {
        var act = b.getAttribute('data-act');
        if (act === 'refresh') fetchLibrary();
        else if (act === 'hub' && window.Hub) window.Hub.open('template');
      });
    });
    zone.querySelectorAll('[data-tpl]').forEach(function (row) {
      row.addEventListener('click', function () {
        var id = row.getAttribute('data-tpl');
        var e = entryById(id);
        if (e) openDetail(e);
      });
    });
  }

  function entryById(id) {
    var all = allEntries();
    for (var i = 0; i < all.length; i++) {
      if (all[i].id === id) return all[i];
    }
    return null;
  }

  function oneLine(s) {
    var line = String(s || '').replace(/\s+/g, ' ').trim();
    return line.length > 110 ? line.slice(0, 109).replace(/\s+\S*$/, '') + '…' : line;
  }

  // ── the detail view ─────────────────────────────────────────────────
  function openDetail(e) {
    if (!cur || !cur.panel) return;
    var entry = e;
    cur.panel.pushView(view('template · ' + (e.name || e.id), function () { return detailHTML(entry); },
      function (el) { wireDetail(el, entry); }));
  }

  function detailHTML(e) {
    var tags = (e.tags || []).map(function (t) {
      return '<span class="ts-chip">#' + esc(t) + '</span>';
    }).join('');
    var active = cur.activeId === e.id;
    var body = '';
    var stages = e.stages || [];
    if (stages.length) {
      body = '<div class="ts-detail-body" id="ts-detail-body">' +
        stages.map(function (st, i) {
          st = st || {};
          var fo = st.fanout && typeof st.fanout === 'object'
            ? '<div class="ts-stage-fo">fan-out over ' + esc(st.fanout.over || 'items') +
              ' · max ' + esc(st.fanout.max_parallel || 1) + ' parallel</div>' : '';
          return (
            '<div class="ts-stage">' +
              '<div class="ts-stage-head"><span class="ts-stage-n">' + (i + 1) + '</span>' +
                '<span class="ts-stage-name">' + esc(st.name || 'stage ' + (i + 1)) + '</span>' +
                (st.role ? '<span class="ts-chip">' + esc(st.role) + '</span>' : '') +
              '</div>' + fo +
              (st.instructions ? '<div class="ts-stage-ins">' + esc(st.instructions) + '</div>' : '') +
            '</div>'
          );
        }).join('') + '</div>';
    } else if (e.markdown) {
      body = '<div class="ts-detail-body ts-md" id="ts-detail-body"></div>';
    } else {
      body = '<div class="ts-detail-body"><div class="ts-empty-sub">this template carries no stages or markdown body — its behavior is engine-side.</div></div>';
    }
    return (
      '<div class="ts-root ts-detail" id="ts-detail-root">' +
        '<div class="ts-detail-head">' +
          '<div class="ts-detail-name">' + esc(e.name || e.id) + ' ' +
            '<span class="ts-chip">' + esc(e.kind || '') + '</span>' +
            (e.task_type && e.task_type !== e.id ? '<span class="ts-chip">' + esc(e.task_type) + '</span>' : '') +
          '</div>' +
          '<div class="ts-detail-desc">' + esc(e.description || '') + '</div>' +
          (tags ? '<div class="ts-tags">' + tags + '</div>' : '') +
        '</div>' +
        body +
        '<div class="ts-detail-actions">' +
          '<button id="ts-use" class="pv-btn pv-btn-primary" style="flex:1">' +
            (active ? '⧉ active — tap to keep' : (e.kind === 'engine' ? '⧉ use deep research' : '⧉ use this template')) +
          '</button>' +
          (isFav(e.id) ? '' : '<button id="ts-fav" class="pv-btn" title="Favorite this template">★ favorite</button>') +
          (e.source === 'hub' && inUserStore(e.id) ? '<button id="ts-del" class="pv-btn" title="Remove from your templates">✕ remove</button>' : '') +
        '</div>' +
      '</div>'
    );
  }

  function wireDetail(el, e) {
    // markdown body through the shared Formatter (esc + theme styling)
    var body = el.querySelector('#ts-detail-body');
    if (body && e.markdown && window.Formatter) {
      try { window.Formatter.renderInto(body, String(e.markdown), { mode: 'full' }); }
      catch (err) { body.textContent = String(e.markdown); }
    }
    var use = el.querySelector('#ts-use');
    if (use) use.addEventListener('click', function () { activate(e); });
    var fav = el.querySelector('#ts-fav');
    if (fav) fav.addEventListener('click', function () {
      toggleFav(e.id);
      toast('favorited ★ — it pins to the top of the library');
      cur.panel.replaceView(view('template · ' + (e.name || e.id),
        function () { return detailHTML(e); },
        function (el2) { wireDetail(el2, e); }));
    });
    var del = el.querySelector('#ts-del');
    if (del) del.addEventListener('click', function () {
      removeUserTemplate(e.id);
      if (cur) cur.user = readUserTemplates();
      toast('removed from your templates');
      var p = PV();
      if (p) { p.popView(); } // back to the list
    });
  }

  // ── activation + publish ────────────────────────────────────────────
  function activate(e) {
    if (!cur) return;
    var cb = cur.onActivate;
    var panel = cur.panel;
    var tpl;
    if (e.kind === 'engine' || e.id === 'deep-research') {
      // the OLD pill's exact behavior: the engine-native pipeline flag
      tpl = { id: 'deep-research', name: 'deep research', deepResearch: true, brief: '' };
    } else {
      tpl = { id: String(e.id || ''), name: String(e.name || e.id || 'template'), brief: buildBrief(e) };
    }
    if (cur) cur.activeId = tpl.id;
    // The host FIRST (it mutates the chat state + arms its repaint
    // flag), THEN the views close — panel.closeViews() restores the
    // stashed composer root and pokes 'doomalay:root-restored', whose
    // listener repaints the toolbar + chip from the fresh state.
    if (cb) {
      try { cb(tpl); } catch (err) { console.error('template activate', err); }
    }
    try { if (panel) panel.closeViews(); } catch (err) {}
    toast('⧉ ' + tpl.name + ' active');
  }

  function publishTemplate(entry) {
    if (!window.HubPublish) { toast('the publisher is not available'); return; }
    var name = '', desc = '', payload = '';
    if (entry) {
      name = String(entry.name || '');
      desc = String(entry.description || '');
      payload = JSON.stringify({
        id: entry.id,
        name: name,
        description: desc,
        task_type: entry.task_type || '',
        kind: 'user',
        tags: entry.tags || [],
        stages: entry.stages || [],
        markdown: entry.markdown || ''
      });
    }
    window.HubPublish.open('template', { name: name, desc: desc, payload: payload });
  }

  // ── Public API ──────────────────────────────────────────────────────
  window.TemplateSheet = {
    open: open,
    saveFromHub: saveFromHub,
    buildBrief: buildBrief,
    isFavorite: isFav,
    // v0.58: hubitem's "use template" parses a hub payload into an entry
    // (stages / markdown) before buildBrief builds its methodology text.
    normalizeHubPayload: normalizeHubPayload
  };
})();
