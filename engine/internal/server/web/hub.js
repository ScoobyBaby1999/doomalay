// hub.js — v0.31→v0.44 THE PUBLIC LIBRARY (the modular hub panel).
//
// USER SPEC (Batch 10): "In the hub panel, let's rename it to Public
// Library, let's put everything that isn't the grid itself as the
// header, except the search bar, which we move under the header. As per
// usual, the header should be collapsible and expandable… the filters
// (recent, downloads, etc) should also be disclosed from the header and
// placed under the search bar… to the right of a new filter icon and
// filter by subtext… displayed in columns instead of pills like so
// Recent | Downloads | Endorsements… Above the persona and template
// pills, we should have a subtext description that says Browse the
// community for: the pills themselves should change to another style of
// pill, one that engulfs its entire row… they should have emojis or
// icons next to them as well, and when selected, the personas should be
// purplish and the templates should be greenish (depending on theme)."
//
// And the keyboard rule: "the search results update with every key
// without making the keyboard go down" — the view is rendered ONCE and
// every interaction (search / sort / tag / tab / steppers / paging)
// updates the DOM surgically (only the grid zone, or the filter states,
// or the library pills). The search input is NEVER re-rendered while
// the hub is on top, so focus — and the mobile keyboard — survive.
//
// The panel still rides the master panel's view stack (panel.js
// pushView — back bar + ✕ + Android back for free).
//
// Exposes: window.Hub = { open, markStale, refreshItem, isDownloaded,
//                         markDownloaded, setHearted, isHearted }
(function () {
  'use strict';

  var GRID_KEY = 'doomalay.hubgrid.v1';
  // v0.58 (user spec pt 4): the show-bundles toggle — ON by default. ON
  // shows the bunch cards and HIDES their member items; OFF hides the
  // bunch cards and shows every individual item.
  // v0.60 pt C.9: bundles are ALWAYS the grid (the toggle was retired
  // with the lib pill wave — everything is a bundle).
  var BUNDLES_KEY = 'doomalay.hubbundles.v1';
  function readBundles() { return true; }
  function saveBundles() {}
  var SORTS = [
    { key: 'recent',    label: 'recent',       sub: 'newest updates first' },
    { key: 'downloads', label: 'downloads',    sub: 'most downloaded first' },
    { key: 'hearts',    label: 'endorsements', sub: 'most endorsed first' },
    { key: 'relevant',  label: 'relevant',     sub: 'the best matches first' }
  ];
  var SORT_SUB = {};
  SORTS.forEach(function (s) { SORT_SUB[s.key] = s.sub; });

  // the library pills' glyphs — future registry types fall back to 📚
  // v0.60 pt C.5: script (⌨ terminal) + doc (📖 book) join the set.
  var LIB_ICONS = { persona: '🎭', template: '🧩', skill: '🛠', theme: '🎨', script: '⌨', doc: '📖' };
  function libIcon(type) { return LIB_ICONS[type] || '📚'; }

  // v0.58 (user spec pts 1 + 8): each browsed library has ONE tone pair that
  // ALL the library chrome follows (publish pill, focused search, sort icons,
  // the bunch chip, the my-xyz pill). The tones are THEME VARS (persona /
  // template tints; skills ride accent-3; themes ride accent-2) — the CSS
  // maps .hub-root[data-tone] → --hub-tone / --hub-tone-rgb.
  function mineLabel(type) {
    return { persona: 'my personas', skill: 'my skills', template: 'my templates', theme: 'my themes', script: 'my scripts', doc: 'my docs' }[type] || 'my items';
  }

  // The served Item carries no local-state flags — the web tracks what
  // THIS session downloaded / hearted so the item detail can enable the
  // endorse button (the engine enforces "download before endorse" with
  // a 400 either way).
  var downloaded = {}; // "type|repo|id" → true
  var hearted = {};    // "type|repo|id" → true

  var cur = null;      // the open hub view's state
  // v0.60 pt B: the BUNCH detail is its OWN pushed view (bcur) — the grid
  // beneath keeps its filters/selection/scroll untouched, so ‹ from a
  // bundle returns to exactly the grid you left (panel.js snapshots the
  // covered view's scroll on push).
  var bcur = null;     // the open bunch view's state

  // v0.67.2: the PERSISTENT DOWNLOAD REGISTRY — keyed by collection
  // id, value = the live progress entry. Defined at MODULE SCOPE
  // v0.60 pt B: BROWSE-STATE PERSISTENCE — the library remembers where
  // you were (type, q, sort, tag, mine, page, folded, scroll) across
  // close→reopen. Saved on every user action + throttled scroll + close;
  // restored on open (an explicit type argument wins; q/tag/mine restore
  // only when the browsed type matches the saved one).
  var HUBSTATE_KEY = 'doomalay.hubstate.v1';
  function saveHubstate() {
    if (!cur) return;
    try {
      localStorage.setItem(HUBSTATE_KEY, JSON.stringify({
        type: cur.type || '',
        q: cur.q || '',
        sort: cur.sort || 'recent',
        tag: cur.tag || '',
        mine: !!cur.mine,
        page: cur.page || 1,
        folded: !!cur.folded,
        scroll: (cur.panel && cur.panel.bodyEl) ? cur.panel.bodyEl.scrollTop : 0
      }));
    } catch (e) {}
  }
  function readHubstate() {
    try { return JSON.parse(localStorage.getItem(HUBSTATE_KEY)) || null; } catch (e) { return null; }
  }

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }
  function escAttr(s) { return esc(s).replace(/"/g, '&quot;'); }
  function stateKey(type, repo, id) { return type + '|' + repo + '|' + id; }

  function PV() {
    var c = window.ChatPanel && window.ChatPanel.current();
    return (c && c.panel) || null;
  }

  // view() — persona.js's helper plus the onClose hook the hub needs
  // (it owns a window-resize listener while open).
  function view(title, renderHTML, wire, onClose) {
    return {
      title: title,
      render: function () { return renderHTML(); },
      onMount: function (el) { if (wire) wire(el); },
      onClose: onClose || null
    };
  }

  var toastTimer = null;
  // v0.58 (user spec pt 7): toast(msg, {hold}) — the transient footer pill.
  // hold keeps it on screen (a "downloading…" / "endorsing…" state) until a
  // later normal toast swaps the text and fades; ms tunes the dwell.
  function toast(msg, opts) {
    var t = document.getElementById('hub-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'hub-toast';
      t.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);' +
        'background:var(--surface-2);color:var(--text-1);border:1px solid var(--border);padding:8px 16px;' +
        'border-radius:10px;font-size:var(--ui-small-fs);z-index:3450;opacity:0;transition:opacity 0.2s;pointer-events:none';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.opacity = '1';
    if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
    if (!(opts && opts.hold)) {
      toastTimer = setTimeout(function () { t.style.opacity = '0'; }, (opts && opts.ms) || 1900);
    }
  }

  // fetch wrapper — rejects with Error(message) + .status, so callers
  // can branch (401 → the connect flow).
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

  // ── the deterministic id-gradient ────────────────────────────────
  // No design on the item → a client-side gradient hashed from the
  // item id, so the same card looks the same everywhere. Fixed S/L
  // bands (60–80% / 45–65%) keep text readable on both themes.
  function hashStr(s) {
    var h = 0;
    for (var i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    return h;
  }
  function hsl(h, s, l) { return 'hsl(' + (h % 360) + ', ' + s + '%, ' + l + '%)'; }
  // v0.58: idColors — the two hashed stops behind idGradient, split out so
  // the bundle FLAG can paint its solid from the same deterministic hash.
  function idColors(id) {
    var h = hashStr(String(id || ''));
    var h1 = Math.abs(h) % 360;
    var h2 = (h1 + 40 + (Math.abs(h >> 8) % 80)) % 360;
    var s1 = 60 + Math.abs(h >> 4) % 21;
    var l1 = 45 + Math.abs(h >> 12) % 21;
    return [hsl(h1, s1, l1), hsl(h2, s1, l1 + 8)];
  }
  function idGradient(id) {
    var c = idColors(id);
    return 'linear-gradient(135deg, ' + c[0] + ', ' + c[1] + ')';
  }

  // ── grid prefs (cols 1–5 × rows 3–100, default 2×10) ──────────
  // v0.56 (user spec): "change the max rows from 10 to 100, and have
  // the default be 10".
  function readGrid() {
    try {
      var g = JSON.parse(localStorage.getItem(GRID_KEY));
      if (g && typeof g.cols === 'number' && typeof g.rows === 'number' &&
          g.cols >= 1 && g.cols <= 5 && g.rows >= 3 && g.rows <= 100) {
        return { cols: g.cols | 0, rows: g.rows | 0 };
      }
    } catch (e) {}
    return { cols: 2, rows: 10 };
  }
  function saveGrid(g) { try { localStorage.setItem(GRID_KEY, JSON.stringify(g)); } catch (e) {} }

  // viewport clamp: never fewer than ~150px of column
  function clampCols(g, containerW) {
    var max = Math.max(1, Math.floor((containerW || 320) / 150));
    return Math.max(1, Math.min(g.cols, max));
  }

  // ── data ─────────────────────────────────────────────────────────
  function fetchLibraries() {
    // v0.67.4: the seq guard — open→close→reopen races resolved against
    // a REPLACED cur (module-level) used to write stale libraries into
    // the fresh state. fetchLibraries had no guard of its own.
    var seq = ++libSeq;
    return api('GET', '/api/hub/libraries').then(function (d) {
      if (!cur || libSeq !== seq) return;
      cur.libraries = (d && d.libraries) || [];
      var hadType = !!cur.type;
      if (!cur.type && cur.libraries.length) cur.type = cur.libraries[0].type;
      // v0.63: a hubstate-restored type that's no longer browsable (docs
      // went Hidden this release) resets to the first visible library.
      if (cur.type && !cur.libraries.some(function (l) { return l && l.type === cur.type; })) {
        cur.type = cur.libraries.length ? cur.libraries[0].type : '';
        hadType = false;
      }
      // v0.67.4: loadItems() ALWAYS fires when a type resolved. The old
      // isTop() gate around the CALL (not the paint) skipped the fetch
      // entirely whenever another view held the panel at that instant —
      // items stayed null forever and the grid rendered the wrong empty
      // state (the "page 1/1, nothing in it; leaving and returning to
      // the app fixes it" report — a restart re-raced the timing).
      // loadItems gates its own paints internally; the fetch is safe
      // from any view state.
      if (cur.type) loadItems();
      // repaint ONLY when the hub view is still the one on top — a view
      // stacked over it (item detail, publish) owns the body meanwhile.
      if (isTop()) updateLibs();
    }).catch(function (e) {
      if (!cur || libSeq !== seq) return;
      cur.libErr = e.message || 'libraries unavailable';
      if (isTop()) updateLibs();
    });
  }
  var libSeq = 0;

  function loadAuth() {
    return api('GET', '/api/hub/auth/status').then(function (d) {
      if (!cur) return;
      cur.auth = d || {};
      if (isTop()) updateStatus();
    }).catch(function () {});
  }

  function loadItems(refresh) {
    if (!cur || !cur.type) return;
    var seq = cur.seq = (cur.seq || 0) + 1;
    cur.loading = true;
    if (isTop()) updateBody();     // the loading state paints immediately
    var qs = [];
    if (cur.q) qs.push('q=' + encodeURIComponent(cur.q));
    qs.push('sort=' + encodeURIComponent(cur.sort));
    if (cur.tag) qs.push('tag=' + encodeURIComponent(cur.tag));
    if (refresh) qs.push('refresh=1');
    api('GET', '/api/hub/' + encodeURIComponent(cur.type) + '/items?' + qs.join('&'))
      .then(function (d) {
        if (!cur || cur.seq !== seq) return;
        cur.loading = false;
        cur.items = (d && d.items) || [];
        cur.err = '';
        cur.page = 1;
        cur.stale = false;
        cur.tags = collectTags(cur.items);
        // v0.60 pt B: the saved page applies once (bodyHTML clamps it to
        // the real page count) + the one-shot scroll restore after the
        // first paint (rAF — the grid needs a frame to lay out).
        if (cur._keepPage) { cur.page = cur._keepPage; cur._keepPage = 0; }
        if (isTop()) { updateLibs(); updateTags(); updateBody(); }
        if (cur._restoreScroll) {
          var bodyEl = cur.panel && cur.panel.bodyEl;
          var y = cur._restoreScroll;
          cur._restoreScroll = 0;
          if (bodyEl) requestAnimationFrame(function () {
            try { bodyEl.scrollTop = y; } catch (e) {}
          });
        }
        seedLocalState(cur.type);   // v0.58: light up downloaded/hearted states
        loadCollections(refresh);
      })
      .catch(function (e) {
        if (!cur || cur.seq !== seq) return;
        cur.loading = false;
        cur.items = [];
        cur.err = e.message || 'the library could not be reached';
        cur.page = 1;
        if (isTop()) { toast(cur.err); updateTags(); updateBody(); }
      });
  }

  // v0.58: seed the session's downloaded/hearted maps from the engine's
  // local rows (the served list carries no per-user state; without this a
  // fresh page shows dead hearts on items the user already has).
  function seedLocalState(type) {
    if (!type) return;
    api('GET', '/api/hub/' + encodeURIComponent(type) + '/downloads')
      .then(function (d) {
        var changed = false;
        ((d && d.items) || []).forEach(function (r) {
          if (!r || !r.item) return;
          if (!isDownloaded(type, r.item.repo, r.item.id)) {
            markDownloaded(type, r.item.repo, r.item.id);
            changed = true;
          }
          if (r.hearted && !isHearted(type, r.item.repo, r.item.id)) {
            setHearted(type, r.item.repo, r.item.id, true);
            changed = true;
          }
        });
        if (changed && isTop() && cur && cur.type === type) updateBody();
      })
      .catch(function () {});
  }

  // v0.52: the bunches for the current q — they ride the grid's first
  // slots. Shares the items' refresh so one ⟳ refreshes both.
  function loadCollections(refresh) {
    if (!cur) return;
    var seq = cur.colSeq = (cur.colSeq || 0) + 1;
    cur.bunchLoading = true;
    if (isTop()) updateBody();
    var qs = [];
    if (cur.q) qs.push('q=' + encodeURIComponent(cur.q));
    if (refresh) qs.push('refresh=1');
    api('GET', '/api/hub/collections?' + qs.join('&'))
      .then(function (d) {
        if (!cur || cur.colSeq !== seq) return;
        cur.bunchLoading = false;
        cur.collections = (d && d.collections) || [];
        if (isTop()) updateBody();
      })
      .catch(function () {
        if (!cur || cur.colSeq !== seq) return;
        cur.bunchLoading = false;
        cur.collections = [];
        if (isTop()) updateBody();
      });
  }

  // v0.60 pt B: OPEN A BUNCH — its own PUSHED view. The grid beneath
  // keeps its filters/selection/scroll (pushView snapshots the covered
  // view's scroll); ‹ pops back to exactly the grid you left.
  function openBunch(id) {
    var panel = PV();
    if (!panel || !cur) return;
    bcur = { panel: panel, id: id, groups: null, loading: true, seq: 0, viewObj: null };
    panel.pushView(bunchView());
    fetchBunch(id);
  }

  function bunchView() {
    var v = view('bundle · ' + (bcur ? bcur.id : 'bundle'), function () { return bunchRender(); },
      function (el) { bunchWire(el); },
      function () { bcur = null; });
    if (bcur) bcur.viewObj = v; // bunchTop()'s identity check
    return v;
  }

  function bunchTop() {
    return !!(bcur && bcur.panel && bcur.viewObj &&
      typeof bcur.panel.topView === 'function' && bcur.panel.topView() === bcur.viewObj);
  }

  function bunchRepaint() {
    if (!bcur || !bcur.panel) return;
    bcur.panel.replaceView(bunchView(), { keepScroll: true });
  }

  // v0.73.6: THE MEMBER FILTER — the live DOM filter behind the bundle
  // detail's filter row (memFilterRow renders it, bunchWire calls here).
  // Matching is a lowercase substring over each card's NAME + DESCRIPTION
  // (the two lines a member is known by — the same fields the hub's own
  // search matches). While a query is live: non-matching cards hide,
  // sections with matches expand (chevron + aria follow the class), the
  // per-section badge and the row's count chip show the LIVE counts, and
  // sections with zero matches hide entirely. Clearing (✕ or Esc or
  // emptying) restores the exact fold state the user had (bcur.secOpen is
  // never mutated here — the folded class is re-derived from it).
  function wireMemberFilter(el) {
    if (!bcur || !el) return;
    var input = el.querySelector('#hub-memq');
    if (!input) return;
    var apply = function () {
      var q = String(bcur.mq || '').trim().toLowerCase();
      var secs = el.querySelectorAll('.hub-bunch-sec');
      var shown = 0, total = 0;
      secs.forEach(function (sec) {
        var t = sec.getAttribute('data-sec');
        var badge = sec.querySelector('.hub-bunch-sec-n');
        var origN = badge ? (badge.getAttribute('data-n') || badge.textContent) : '';
        var cards = sec.querySelectorAll('.hub-card');
        var vis = 0;
        cards.forEach(function (card) {
          total++;
          var name = card.querySelector('.hub-card-name-in');
          var desc = card.querySelector('.hub-card-desc');
          var txt = ((name ? name.textContent : '') + ' ' + (desc ? desc.textContent : '')).toLowerCase();
          var hit = !q || txt.indexOf(q) >= 0;
          card.style.display = hit ? '' : 'none';
          if (hit) vis++;
        });
        var head = sec.querySelector('.hub-bunch-sec-h');
        if (q) {
          sec.style.display = vis ? '' : 'none';
          if (vis) {
            sec.classList.remove('folded');
            if (head) head.setAttribute('aria-expanded', 'true');
          }
          if (badge) badge.textContent = String(vis);
        } else {
          sec.style.display = '';
          var want = !!(bcur.secOpen && bcur.secOpen[t]);
          sec.classList.toggle('folded', !want);
          if (head) head.setAttribute('aria-expanded', want ? 'true' : 'false');
          if (badge) badge.textContent = String(origN);
        }
        shown += vis;
      });
      var x = el.querySelector('#hub-memq-x');
      var n = el.querySelector('#hub-memq-n');
      var empty = el.querySelector('#hub-memq-empty');
      if (x) x.hidden = !q;
      if (n) { n.hidden = !q; n.textContent = q ? (shown + ' of ' + total) : ''; }
      if (empty) {
        empty.hidden = !(q && shown === 0);
        if (q && shown === 0) empty.textContent = 'no members match “' + q + '” — clear the filter or try another word';
      }
    };
    input.addEventListener('input', function () {
      bcur.mq = input.value;
      apply();
    });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        input.value = '';
        bcur.mq = '';
        apply();
        input.focus();
      }
    });
    var clearBtn = el.querySelector('#hub-memq-x');
    if (clearBtn) clearBtn.addEventListener('click', function () {
      input.value = '';
      bcur.mq = '';
      apply();
      input.focus();
    });
    // a repaint (section flip / view switch / download pill) re-rendered
    // the row — the value rode in via bcur.mq; re-apply the card filter.
    if (String(bcur.mq || '')) apply();
  }

  function fetchBunch(id) {
    if (!bcur) return;
    var seq = bcur.seq = (bcur.seq || 0) + 1;
    api('GET', '/api/hub/collections/' + encodeURIComponent(id) + '/items')
      .then(function (d) {
        if (!bcur || bcur.seq !== seq) return;
        bcur.loading = false;
        bcur.groups = (d && d.groups) || [];
        if (bunchTop()) bunchRepaint();
      })
      .catch(function (e) {
        if (!bcur || bcur.seq !== seq) return;
        bcur.loading = false;
        bcur.groups = [];
        if (bunchTop()) { toast(e.message || 'the bunch could not be reached'); bunchRepaint(); }
      });
  }

  // the bunch view render — a hero (the bunch's own design + flag) + the
  // cross-library member sections, one grid per type.
  // v0.72: THE PARITY CARD (user spec: "it shouldn't look different from
  // viewing single files… every item published in the library should act
  // as a bundle, even if it has just 1 item/file within — visually it
  // should look and function the same"). The hero body mirrors hi-head's
  // EXACT row stack — name+icon / description / meta / TAGS (top 5 +
  // "+N") / counts (Σ hearts · Σ downloads) — and the two rectangular
  // pills retire in favor of the SAME circular FAB row the single-item
  // view wears: ⤓ download (live N/M + a progress ring) · ♥ endorse
  // (locked until downloaded, exactly the single-item rule) · ▶ use
  // bundle (when downloaded) · 🗑 delete-your-copies (the confirm bar).
  // v0.76.7: THE FOLDABLE HERO — the user's bundle-page parity ask: the
  // hero folds like hi-head (tap the head), and the COLLAPSED layout is
  // the user's spec — "name, x bundled items - x docs, y skills, ext…"
  // (the content line STAYS; chips + the by-line fold away). The
  // expanded stack is the single item's exact row order.
  // v0.77.6: THE UPSTREAM CREDIT — "by <publisher> — ported from <upstream>"
  // on every byline (user spec: a port must NEVER read as the publisher's
  // own work). Empty upstream = original work = no suffix.
  function creditSuffix(upstream) {
    var u = String(upstream || '').trim();
    return u ? ' — ported from ' + esc(u) : '';
  }

  function bunchRender() {
    if (!bcur) return '';
    var b = bunchMeta(bcur.id);
    var I = window.IconLib;
    // v0.61 (icons): file:<path> icons render as the item's own art file
    // (png/svg through the repo-file route); kebab names stay Lucide glyphs.
    var ico = I ? (I.card(b.icon, b.repo, 22) || I.svg('package', 22)) : '';
    var bits = [];
    var byType = b.byType || {};
    Object.keys(byType).forEach(function (t) {
      bits.push(byType[t] + ' ' + shortType(t) + (byType[t] === 1 ? '' : 's'));
    });
    // v0.77.10: THE DESCRIPTION + THE INFO LINE — the user's spec: the
    // header shows the bundle's REAL one-or-two-line description (the
    // publisher's manifest — "superpowers-obra should have a very simple
    // description of what it does, and that it's a port from obra"),
    // and the deterministic census — "N bundled items — x docs · y
    // skills…" — rides BENEATH it as the info text (it was never a
    // description). The server resolves the manifest (the corpus pass
    // committed collections/superpowers-obra.json); the fallback is the
    // most-endorsed member's text.
    var total = b.members || 0;
    var contentLine = total + ' bundled item' + (total === 1 ? '' : 's') +
      (bits.length ? ' — ' + bits.join(' · ') : '');
    var descLine = String(b.description || '').trim();
    var descRow = descLine
      ? '<div class="hi-desc hub-bunch-hero-desc">' + esc(descLine) + '</div>' +
        '<div class="hi-desc hub-bunch-hero-info" style="font-size:calc(var(--ui-small-fs) - 1px);opacity:0.82">' + esc(contentLine) + '</div>'
      : '<div class="hi-desc hub-bunch-hero-desc">' + esc(contentLine) + '</div>';
    var flag = (b.tag || '').trim()
      ? '<span class="hub-bundle-flag"' + flagStyle(b) + '><b>#' + esc(String(b.tag).trim()) +
        '</b><i>bundle</i></span>' : '';
    // the parity pieces (see bunchMembers / bundleHeartState below)
    var members = bunchMembers();
    var dlState = bcur.loading ? null : bdlEntry(bcur.id);
    var downloaded = !!(!bcur.loading && dlState && dlState.state === 'done');
    // v0.77.10: the heart state = the COLLECTION's own heart (one per
    // user), served with the summary; the legacy all-members read stays
    // as the fallback for pre-wave states.
    var allHearted = (b && typeof b.hearted === 'boolean') ? b.hearted : bundleHeartState(members);
    // THE TAG ROW — the server's vote-ranked tags; the first five ride
    // hi-chips (the single item's exact chip), the rest fold into "+N"
    // (the title carries the full list for hover/long-press readers).
    var tags = (b && Array.isArray(b.tags)) ? b.tags : [];
    var shown = tags.slice(0, 5);
    var chips = shown.map(function (t) {
      return '<span class="hi-chip">#' + esc(t) + '</span>';
    }).join('');
    if (tags.length > 5) {
      chips += '<span class="hi-chip hi-chip--info" title="' + escAttr(tags.slice(5).join(', ')) +
        '">+' + (tags.length - 5) + '</span>';
    }
    var chipsRow = chips
      ? '<div class="hi-chips">' + chips + '</div>' : '';
    // THE COUNTS ROW — Σ member hearts + Σ member downloads (the
    // summary aggregates them server-side; a downloaded member counts
    // its +1, exactly the single item's served counters).
    var countsRow =
      '<div class="hi-counts">' +
        '<span>' + heartGlyph(false) + '<b>' + (b.hearts || 0) + '</b></span>' +
        '<span>' + dlGlyph() + '<b>' + (b.downloads || 0) + '</b></span>' +
      '</div>';
    var hero =
      '<div class="hub-bunch-hero' + ((bcur && bcur.folded) ? ' folded' : '') + '" id="hub-bunch-hero"' +
        ' role="button" tabindex="0" aria-expanded="' + ((bcur && bcur.folded) ? 'false' : 'true') + '"' +
        ' aria-label="fold the bundle card" style="background-image:' +
        ((window.Hub && window.Hub.idGradient) ? window.Hub.idGradient(bcur.id) : 'none') + '">' +
        '<span class="hub-bunch-hero-bg" data-bunchbg="1"></span>' +
        '<span class="hub-bunch-hero-scrim" aria-hidden="true"></span>' +
        '<div class="hub-bunch-hero-body">' +
          '<div class="hub-bunch-hero-titlerow">' +
            (ico ? '<span class="hub-card-ico" aria-hidden="true">' + ico + '</span>' : '') +
            '<span class="hub-bunch-hero-name">' + esc(bcur.id) + '</span>' +
          '</div>' +
          descRow +
          '<div class="hi-meta">by ' + esc(b.by || 'unknown') + creditSuffix(b.upstream) +
            (b.updatedAt ? ' · updated ' + esc(String(b.updatedAt).slice(0, 10)) : '') + '</div>' +
          chipsRow +
          countsRow +
        '</div>' +
        '<span class="hi-fold-ico">' + ((bcur && bcur.folded) ? '▸' : '▾') + '</span>' +
        flag +
      '</div>';
    var body = '';
    // v0.63 (user spec pt 6): the REPO-VIEW AVAILABILITY — a bundle whose
    // members have no repo (a singular item) or the builtin sentinel
    // (deep research → "HF rejected the token") gets a disabled segment
    // reading "repo view unavailable" instead of a tree that 404s. The
    // live probe (HubRepo.probe) double-checks real repos async and flips
    // the pill if HF refuses it.
    var bRepo = bunchRepo(bcur.id);
    var repoAvail = !!bRepo && bRepo !== 'doomalay/builtin' && !bcur.repoNA;
    // v0.60 pt C.8: the [cards|repo] pill — cards = the member sections,
    // repo = the artifacts-style tree of the bunch's publishing repo.
    // v0.63 (user spec pt 4): the sections render COLLAPSED by default —
    // tap the header row to expand that section (see bunchWire).
    var viewPill = repoAvail
      ? '<div class="hi-viewrow"><div class="hi-viewseg" role="group" aria-label="bundle view">' +
          '<button type="button" data-bv="cards"' + (bcur.view !== 'repo' ? ' class="on"' : '') + '>cards</button>' +
          '<button type="button" data-bv="repo"' + (bcur.view === 'repo' ? ' class="on"' : '') + '>repo</button>' +
        '</div></div>'
      : '<div class="hi-viewrow"><div class="hi-viewseg" role="group" aria-label="bundle view">' +
          '<button type="button" class="on">cards</button>' +
          '<button type="button" disabled title="this bundle has no browsable repo">repo view unavailable</button>' +
        '</div></div>';
    if (bcur.view === 'repo' && repoAvail) {
      body = viewPill + '<div class="hubrepo-tree" id="hubrepo-tree"></div>';
    } else if (bcur.loading) {
      body = viewPill + '<div class="art-loading">loading the bundle…</div>';
    } else {
      var groups = bcur.groups || [];
      if (!groups.length) {
        body = viewPill + '<div class="hub-empty">the bundle “' + esc(bcur.id) + '” has no members anymore</div>';
      } else {
        var secs = '';
        groups.forEach(function (g) {
          var open = !!(bcur.secOpen && bcur.secOpen[g.type]);
          secs += '<div class="hub-bunch-sec' + (open ? '' : ' folded') + '" data-sec="' + escAttr(g.type) + '">' +
            '<div class="hub-bunch-sec-h" role="button" tabindex="0" aria-expanded="' + (open ? 'true' : 'false') + '">' +
              libIcon(g.type) + ' ' + esc(shortType(g.type)) + 's' +
              ' <span class="hub-bunch-sec-n" data-n="' + g.items.length + '">' + g.items.length + '</span>' +
              '<span class="hub-sec-chev" aria-hidden="true">▸</span></div>' +
            '<div class="hub-grid" style="--hub-cols:' + clampCols(cur && cur.grid, bcur.panel && bcur.panel.bodyEl ? bcur.panel.bodyEl.clientWidth : 320) + '">' +
              g.items.map(cardHTML).join('') +
            '</div>' +
          '</div>';
        });
        body = viewPill + memFilterRow(groups) + secs;
      }
    }
    // v0.72: THE FAB ROW — the single-item view's exact chrome (hi-fabs /
    // hi-fab, sticky-docked at the body's foot). The confirm bar swaps
    // the whole row, exactly like hubitem's delete flow.
    var dlTitle = dlPillTitle(dlState, b.members || 0);
    var fabs =
      '<div class="hi-fabs">' +
        (bcur.confirmDel
          ? '<div class="hi-delbar" id="hub-bundle-delbar" role="alertdialog" aria-label="confirm delete">' +
              '<span class="hi-delbar-text">Remove every downloaded item of <b>' + esc(bcur.id) +
                '</b> from your device?</span>' +
              '<button type="button" class="hi-delbar-btn" data-del="keep">keep</button>' +
              '<button type="button" class="hi-delbar-btn hi-delbar-btn--rm" data-del="remove">remove</button>' +
            '</div>'
          : '') +
        (downloaded && !bcur.confirmDel
          ? '<button class="hi-fab hi-fab--use" id="hub-bundle-use" type="button"' +
              ' title="use the whole bundle — the bot reads it and picks the right member for each task"' +
              ' aria-label="use the whole bundle">' + fabGlyph('play') + '</button>'
          : '') +
        (!bcur.confirmDel
          ? '<button class="hi-fab' + (dlState && dlState.state === 'done' ? ' is-done' : '') +
              (dlState && dlState.state === 'running' ? ' is-running' : '') + '" id="hub-bundle-dl" type="button"' +
              ' title="' + escAttr(dlTitle) + '" aria-label="' + escAttr(dlTitle) + '">' +
              dlFabInner(dlState, b.members || 0) + '</button>'
          : '') +
        (!bcur.confirmDel
          ? '<button class="hi-fab hi-fab--heart' + (allHearted ? ' on' : '') +
              (downloaded ? '' : ' locked') + '" id="hub-bundle-heart" type="button"' +
              (downloaded ? ' title="endorse every item in the bundle"' : ' title="download first"') +
              ' aria-label="endorse the bundle">' + fabGlyph('heart', allHearted) + '</button>'
          : '') +
        (downloaded && !bcur.confirmDel
          ? '<button class="hi-fab hi-fab--del" id="hub-bundle-del" type="button"' +
              ' title="delete your copies" aria-label="delete your copies of this bundle">' +
              fabGlyph('trash-2') + '</button>'
          : '') +
      '</div>';
    return '<div class="hub-root hub-root--bunch" data-tone="' + escAttr((cur && cur.type) || '') + '">' + hero +
      '<div class="hub-bodyzone">' + body + '</div>' + fabs + '</div>';
  }

  // v0.72: the bundle's flat member list (type + repo + id + the item) —
  // the heart state, the endorse fan-out, and the use-bundle manifest all
  // read it. Empty while the groups load (the FABs account for that).
  function bunchMembers() {
    var out = [];
    ((bcur && bcur.groups) || []).forEach(function (g) {
      (g.items || []).forEach(function (it) {
        if (it) out.push({ type: g.type || it.type || 'item', repo: it.repo || '', id: it.id || '', item: it });
      });
    });
    return out;
  }

  // v0.72: the bundle heart state — ON only when EVERY member is hearted
  // (an all-or-nothing read; the fan-out makes the tap land exactly there).
  // No members yet (loading) = not on.
  function bundleHeartState(members) {
    if (!members || !members.length) return false;
    for (var i = 0; i < members.length; i++) {
      var m = members[i];
      if (!isHearted(m.type, m.repo, m.id)) return false;
    }
    return true;
  }

  // v0.72: the FAB glyphs — the single-item view's exact IconLib shapes
  // (26px, the heart fills when on; the DOS fallbacks match hubitem's).
  function fabGlyph(name, filled) {
    var I = window.IconLib;
    if (!I || !I.has(name)) {
      return { heart: '♥', download: '⤓', 'pen-line': '✎', play: '▶', 'trash-2': '🗑' }[name] || '';
    }
    var s = I.svg(name, 26);
    if (filled) s = s.replace('fill="none"', 'fill="currentColor"');
    return s;
  }

  // v0.72: the download FAB's inner HTML, from the registry state — the
  // pill's old wordy labels die with the pill; a 62px circle carries a
  // glyph or a terse N/M, and the progress ring (CSS, --dl-p) carries
  // the live fill while running.
  function dlFabInner(e, fallbackTotal) {
    if (!e) return fabGlyph('download');
    if (e.state === 'running') {
      return '<span class="hub-dl-count">' + (e.done || 0) + '/' + (e.total || fallbackTotal || 0) + '</span>';
    }
    if (e.state === 'done') return '<span class="hub-dl-ok">✓</span>';
    return fabGlyph('download'); // partial / stale / error → the ⤓ (the title explains)
  }

  // v0.73.6: THE MEMBER FILTER — a bundle can hold dozens to thousands of
  // members (the hub's own search narrows bundles; THIS narrows INSIDE
  // one). Live DOM filter over each card's name + description: typing
  // never re-renders (focus is never lost), matching sections expand for
  // the duration, and clearing restores the user's fold state exactly
  // (bcur.secOpen is never touched by the filter). Only bundles with 8+
  // members get the row — smaller ones read at a glance.
  function memFilterRow(groups) {
    var total = 0;
    (groups || []).forEach(function (g) { total += (g.items || []).length; });
    if (total < 8) return '';
    var mq = String((bcur && bcur.mq) || '');
    return '<div class="hub-memrow" id="hub-memrow">' +
        '<input id="hub-memq" type="text" inputmode="search" class="hub-search"' +
          ' placeholder="filter members — name or description" value="' + escAttr(mq) + '"' +
          ' aria-label="filter the members of this bundle">' +
        '<button type="button" id="hub-memq-x" class="hub-memq-x"' + (mq ? '' : ' hidden') +
          ' aria-label="clear the member filter" title="clear">✕</button>' +
        '<span class="hub-memq-n" id="hub-memq-n"' + (mq ? '' : ' hidden') + '></span>' +
      '</div>' +
      '<div class="hub-memq-empty" id="hub-memq-empty" hidden>no members match — clear the filter or try another word</div>';
  }

  // the bunch view's meta — the collections list the GRID loaded (this
  // view only opens from a bunch card, so cur is alive and holds it).
  function bunchMeta(id) {
    var list = (cur && cur.collections) || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].id === id) return list[i];
    }
    return { id: id, members: 0, byType: {}, tag: '', design: null, icon: '', repo: '' };
  }

  // v0.60 pt C.8: the repo the bunch publishes through — its FIRST member's
  // repo (a bunch is one publisher's listing; mixed-repo bunches fall back
  // to the first member that has one).
  function bunchRepo(id) {
    var groups = (bcur && bcur.groups) || [];
    for (var i = 0; i < groups.length; i++) {
      var items = groups[i].items || [];
      for (var j = 0; j < items.length; j++) {
        if (items[j] && items[j].repo) return items[j].repo;
      }
    }
    return '';
  }

  function bunchWire(el) {
    if (!bcur || !el) return;
    var c = cur;
    // v0.76.7: THE FOLDABLE HERO — the single item's exact interaction
    // (tap the head, the rows collapse; no re-render, the class flips).
    // The content line stays (the user's collapsed layout); chips, the
    // by-line and the counts fold away.
    var hero = el.querySelector('#hub-bunch-hero');
    if (hero) {
      var foldHero = function () {
        hero.classList.toggle('folded');
        var fico = hero.querySelector('.hi-fold-ico');
        if (fico) fico.textContent = hero.classList.contains('folded') ? '▸' : '▾';
        hero.setAttribute('aria-expanded', hero.classList.contains('folded') ? 'false' : 'true');
        if (bcur) bcur.folded = hero.classList.contains('folded');
      };
      hero.addEventListener('click', function (e) {
        // taps on the FAB row / interactive children must not fold
        if (e.target && e.target.closest && e.target.closest('.hi-fabs, button')) return;
        foldHero();
      });
      hero.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); foldHero(); }
      });
    }
    // member cards → the item detail (the same open path the grid uses)
    el.querySelectorAll('[data-item]').forEach(function (b) {
      var id = b.getAttribute('data-item');
      var it = findItem(id);
      if (!it) return;
      b.addEventListener('click', function () {
        if (window.HubItem) window.HubItem.open(it.type || (c && c.type), it);
      });
      var bg = b.querySelector('[data-bgcard]');
      if (bg) paintCardBg(bg, it);
    });
    // the hero's art layer — the bunch's own design
    var heroBg = el.querySelector('[data-bunchbg]');
    if (heroBg) paintBunchBg(heroBg, bunchMeta(bcur.id));
    // v0.60 pt C.6 → v0.72: the one-press bundle download — the runner
    // (registry + per-member fan-out) lives on the ⤓ FAB now; the click
    // just arms it. Running taps say so (no double-run); a done bundle
    // says so (already yours); partial/stale/error tap = resume/retry.
    var dl = el.querySelector('#hub-bundle-dl');
    if (dl) dl.addEventListener('click', function () {
      if (!bcur) return;
      var e = bdlEntry(bcur.id);
      if (e && e.state === 'running') {
        toast('already downloading — ' + (e.done || 0) + '/' + (e.total || 0), { ms: 1600 });
        return;
      }
      if (e && e.state === 'done') {
        toast('the whole bundle is already yours — ' + (e.total || 0) + ' items', { ms: 2100 });
        return;
      }
      runBundleDownload(bcur.id);
    });
    // mount-time paint: the render emits the registry state; this stamps
    // the live --dl-p ring + classes onto it (a download running in the
    // background repaints into a freshly opened bunch view).
    if (dl) paintDlPill();
    // v0.72: THE ENDORSE FAN-OUT — the bundle heart acts exactly like a
    // single item's: locked until the bundle is downloaded (the engine
    // guards per member anyway), then one tap endorses EVERY member (or
    // removes them all when the bundle is fully hearted). Failures are
    // counted and reported, never fatal.
    var heart = el.querySelector('#hub-bundle-heart');
    if (heart) heart.addEventListener('click', function () {
      if (!bcur) return;
      var members = bunchMembers();
      if (!members.length) {
        toast('the bundle is still loading — try again in a moment', { ms: 2400 });
        return;
      }
      var e = bdlEntry(bcur.id);
      if (!(e && e.state === 'done')) {
        toast('download first — endorsing needs a download', { ms: 2400 });
        return;
      }
      // v0.77.10: the direction rides the COLLECTION's served heart (one
      // per user) — the member fan-out state is retired
      var hb = bunchMeta(bcur.id);
      var nowOn = (hb && typeof hb.hearted === 'boolean') ? hb.hearted : bundleHeartState(members);
      setBundleHeart(!nowOn, members);
    });
    // v0.72: THE DELETE FAB — the mine view's doBundleDelete (engine
    // rows + session marks + "Yours" copies + the registry), behind the
    // same keep/remove confirm bar the single item wears.
    var del = el.querySelector('#hub-bundle-del');
    if (del) del.addEventListener('click', function () {
      if (!bcur) return;
      bcur.confirmDel = true;
      bunchRepaint();
    });
    var dbar = el.querySelector('#hub-bundle-delbar');
    if (dbar) dbar.querySelectorAll('[data-del]').forEach(function (b2) {
      b2.addEventListener('click', function () {
        if (!bcur) return;
        if (b2.getAttribute('data-del') === 'remove') { doBundleDelete(bcur.id); bcur.confirmDel = false; return; }
        bcur.confirmDel = false;
        bunchRepaint();
      });
    });
    // v0.71: USE THE WHOLE BUNDLE — hand the connected chat the bundle
    // manifest (type/name/desc/repo/id per member, from the loaded
    // groups); ChatPanel.applyBundle arms the lib gate + the PM turn's
    // decision protocol. v0.72: it's the ▶ FAB (shown once downloaded).
    var use = el.querySelector('#hub-bundle-use');
    if (use) use.addEventListener('click', function () {
      if (!bcur) return;
      var chat = window.Hub && window.Hub.chat ? window.Hub.chat() : null;
      if (!chat || !chat.sessionId) {
        toast('connect a chat first — tap the chat pill', { ms: 2400 });
        return;
      }
      if (!(window.ChatPanel && window.ChatPanel.applyBundle)) {
        toast('this build has no bundle support');
        return;
      }
      var members = bunchMembers().map(function (m) {
        var it = m.item || {};
        return {
          type: m.type,
          name: it.name || m.id || '?',
          desc: it.description || '',
          repo: m.repo,
          id: m.id
        };
      });
      if (!members.length) {
        toast('the bundle is still loading — try again in a moment', { ms: 2400 });
        return;
      }
      var meta = bunchMeta(bcur.id);
      window.ChatPanel.applyBundle({
        id: bcur.id,
        name: bcur.id,
        tag: (meta && meta.tag) || '',
        members: members
      });
    });
    // v0.63 (user spec pt 4): the section headers toggle their sections
    // (collapsed is the default state — see bunchRender).
    el.querySelectorAll('.hub-bunch-sec-h').forEach(function (h) {
      var sec = h.parentElement;
      if (!sec || !sec.classList.contains('hub-bunch-sec')) return;
      var flip = function () {
        if (!bcur) return;
        var t = sec.getAttribute('data-sec');
        if (!t) return;
        bcur.secOpen = bcur.secOpen || {};
        bcur.secOpen[t] = !bcur.secOpen[t];
        bunchRepaint();
      };
      h.addEventListener('click', flip);
      h.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flip(); }
      });
    });
    // v0.73.6: THE MEMBER FILTER (see memFilterRow) — wired AFTER the
    // section headers so a repaint (section flip / view switch / download
    // pill repaint) re-applies the live filter from bcur.mq and the
    // input keeps its text (the render carries value=bcur.mq).
    wireMemberFilter(el);
    // v0.60 pt C.8: the [cards|repo] pill — repo mounts the artifacts-style
    // tree; file rows matching a member's payload File open ITS card.
    var seg = el.querySelector('.hi-viewseg');
    if (seg) seg.querySelectorAll('[data-bv]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (!bcur) return;
        bcur.view = b.getAttribute('data-bv');
        bunchRepaint();
      });
    });
    var treeEl = el.querySelector('#hubrepo-tree');
    if (treeEl && window.HubRepo) {
      var repo = bunchRepo(bcur.id);
      var byPath = {};
      (bcur.groups || []).forEach(function (g) {
        (g.items || []).forEach(function (it) {
          if (it && it.file) byPath[it.file] = it;
        });
      });
      window.HubRepo.mount(treeEl, repo, {
        itemsByPath: byPath,
        onOpenItem: function (it) {
          if (it && window.HubItem) window.HubItem.open(it.type, it);
        }
      });
    }
    // v0.63 (user spec pt 6): the async repo-availability probe — real
    // repos get one cheap tree fetch; if HF refuses it (401/404) the pill
    // flips to "repo view unavailable" (cached per repo in HubRepo).
    var probeRepo = bunchRepo(bcur.id);
    if (window.HubRepo && probeRepo && probeRepo !== 'doomalay/builtin' && !bcur.repoNA) {
      window.HubRepo.probe(probeRepo).then(function (ok) {
        if (!ok && bcur && !bcur.repoNA) {
          bcur.repoNA = true;
          if (bcur.view === 'repo') bcur.view = 'cards';
          bunchRepaint();
        }
      });
    }

    // live hearts on the member cards (the shared grid handler)
    wireCardHearts(el);
    marqueeScan(el);
  }

  // v0.60 pt C.6 → v0.67.5: doBundleDownload (the single-POST-then-side-
  // effects flow) is RETIRED — runBundleDownload above replaces it with
  // the registry + the per-member fan-out (real progress, resumable,
  // persistent). The server's /api/hub/collections/{id}/download
  // endpoint stays for other clients; the web app no longer calls it.

  // the persona side effect of a bundle download — the hubitem.js
  // importPersona pattern (GET the session → append inactive → PATCH).
  function importPersonaInto(sessionId, item, payload) {
    if (!sessionId || !window.ChatPanel || !window.ChatPanel.current()) return;
    fetch('/api/sessions/' + encodeURIComponent(sessionId))
      .then(function (r) { return r.json(); })
      .then(function (sess) {
        var list = [];
        try { list = JSON.parse((sess && sess.Personas) || '[]') || []; } catch (e) { list = []; }
        if (!list.length) {
          list = [{ id: 'p_default', name: 'Default', text: (sess && sess.Persona) || '', mode: 'always' }];
        }
        for (var i = 0; i < list.length; i++) {
          if (list[i].id === item.id) return; // already imported
        }
        list.push({ id: item.id, name: item.name, text: payload || '', mode: 'inactive' });
        return fetch('/api/sessions/' + encodeURIComponent(sessionId), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ personas: JSON.stringify(list) })
        });
      })
      .catch(function () {}); // the local row already saved — the import is a bonus
  }

  // ── v0.67.5: THE BUNDLE DOWNLOAD REGISTRY + RUNNER ────────────────
  // User report: the download pill was a static "downloading…" owned by
  // the VIEW (bcur.dlBusy) — leave the bundle, come back, and the in-
  // flight download had silently become "download all N" again; and the
  // one-POST endpoint returned EVERY member payload in a single JSON,
  // big enough to stall on obra-sized bundles. THE FIX, in three parts:
  //
  // 1. THE REGISTRY (module state + localStorage doomalay.bundledl.v1):
  //    { state: running|done|partial|error|stale, done, total, failed,
  //      lastErr, at } keyed by bundle id. Survives view switches AND
  //    app restarts. A 'running' entry from a dead session loads as
  //    'stale' — the pill offers RESUME instead of a lying spinner.
  //
  // 2. THE RUNNER (runBundleDownload): client-side fan-out over the
  //    members, 3 wide — each member rides the SAME POST the item
  //    detail's ⤓ makes (/api/hub/{type}/download {repo,id}), then the
  //    SAME per-type side effects the old single-POST path applied
  //    (template/skill → the user's library, persona → the chat, theme
  //    → the look). Already-downloaded members count instantly (a
  //    resume only fetches what's missing). Per-member failures are
  //    counted and never fatal — a half-offline bundle still lands its
  //    rest, exactly the server's old semantics.
  //
  // 3. THE PILL: painted from the registry on every render AND after
  //    every member (surgical innerHTML swap — listeners live on the
  //    button). States: idle / N-M-downloading (with a live progress
  //    fill) / ✓-downloaded-N / resume-N-M (+F failed) / retry. The
  //    server's collection-download endpoint stays (compat) — the
  //    client just no longer needs its everything-at-once answer.
  var BDL_KEY = 'doomalay.bundledl.v1';
  var bundleDL = null;
  function bdlLoad() {
    if (bundleDL) return bundleDL;
    try { bundleDL = JSON.parse(localStorage.getItem(BDL_KEY)) || {}; }
    catch (e) { bundleDL = {}; }
    // a 'running' entry from a previous session is a lie — the runner
    // died with the page. Mark it stale: the pill offers a resume.
    Object.keys(bundleDL).forEach(function (id) {
      if (bundleDL[id] && bundleDL[id].state === 'running') bundleDL[id].state = 'stale';
    });
    return bundleDL;
  }
  function bdlSave() {
    try { localStorage.setItem(BDL_KEY, JSON.stringify(bundleDL)); } catch (e) {}
  }
  function bdlEntry(id) {
    var r = bdlLoad();
    var e = r[id] || null;
    return (e && typeof e.done === 'number') ? e : null;
  }
  function bdlSet(id, entry) {
    var r = bdlLoad();
    r[id] = entry;
    bdlSave();
  }

  // the per-type side effects of a bundle member download — the exact
  // ones the old doBundleDownload applied (kept verbatim in spirit).
  function applyHubSideEffects(type, item, payload) {
    var chat = cur ? cur.chat : null;
    var sid = chat && chat.sessionId ? chat.sessionId : '';
    if ((type === 'template' || type === 'skill') &&
        window.TemplateSheet && window.TemplateSheet.saveFromHub) {
      window.TemplateSheet.saveFromHub(item, payload);
    }
    if (type === 'persona') importPersonaInto(sid, item, payload);
    if (type === 'theme' && window.LookIO && window.LookIO.importText) {
      window.LookIO.importText(payload);
    }
  }

  // the download FAB's title, from the registry state (fallbackTotal =
  // the bunch summary's member count when no entry exists yet).
  function dlPillTitle(e, fallbackTotal) {
    if (!e) return 'download every item in this bundle';
    if (e.state === 'running') return 'downloading — ' + (e.done || 0) + ' of ' + (e.total || 0) + ' done';
    if (e.state === 'done') return 'the whole bundle is downloaded';
    if (e.state === 'partial') return 'resume — ' + (e.failed || 0) + ' member' + ((e.failed || 0) === 1 ? '' : 's') + ' failed';
    if (e.state === 'stale') return 'the last download was interrupted — resume it';
    return 'the download failed — retry';
  }
  // paint the download FAB (render-time AND after every member: a
  // surgical swap — the click listener lives on the button itself).
  // v0.72: the pill became the ⤓ FAB; the N/M count + the --dl-p ring
  // replace the old wordy label + fill bar, and is-done/is-running ride
  // the same classes (the FAB's own CSS styles them).
  function paintDlPill() {
    if (!bcur || !bcur.panel || !bcur.panel.bodyEl) return;
    var btn = bcur.panel.bodyEl.querySelector('#hub-bundle-dl');
    if (!btn) return;
    var b = bunchMeta(bcur.id);
    var e = bdlEntry(bcur.id);
    btn.innerHTML = dlFabInner(e, (b && b.members) || 0);
    btn.title = dlPillTitle(e, (b && b.members) || 0);
    btn.setAttribute('aria-label', btn.title);
    if (e && e.state === 'running' && e.total) {
      btn.style.setProperty('--dl-p', String(Math.max(0, Math.min(1, (e.done || 0) / e.total))));
    } else {
      btn.style.removeProperty('--dl-p');
    }
    btn.classList.toggle('is-running', !!(e && e.state === 'running'));
    btn.classList.toggle('is-done', !!(e && e.state === 'done'));
  }

  // v0.77.10: THE ONE BUNDLE HEART — endorse (or un-endorse) the WHOLE
  // bundle as ONE per-user heart on the collection (the user's spec:
  // "if one user endorses the bundle it counts as 1" — never a fan-out
  // over the members: a 45-member bundle reads +1, not +45). The engine
  // gates on the bundle being downloaded (the same endorse-before-
  // download rule); the members' own counters never move (a member view
  // shows its own hearts PLUS the bundle's — the server-side
  // applyCollectionCounts).
  function setBundleHeart(on, members) {
    if (!bcur) return;
    toast(on ? 'endorsing the bundle…' : 'removing the endorsement…', { hold: true });
    api('POST', '/api/hub/collections/' + encodeURIComponent(bcur.id) +
        (on ? '/endorse' : '/unendorse'), {})
      .then(function (d) {
        var meta = bunchMeta(bcur.id);
        if (meta) {
          meta.hearts = (d && typeof d.hearts === 'number') ? d.hearts
            : Math.max(0, (meta.hearts || 0) + (on ? 1 : -1));
          meta.hearted = on;
        }
        toast(on ? 'endorsed the bundle ♥ — one heart, the whole bundle'
                 : 'endorsement removed');
        if (bunchTop()) bunchRepaint();
        else if (isTop()) updateBody();
      })
      .catch(function (e2) {
        toast((e2 && e2.message) || 'could not endorse the bundle', { ms: 2400 });
      });
  }

  // THE RUNNER — see the block comment above. Returns nothing; the
  // registry + the pill + a final repaint + a summary toast ARE the UI.
  function runBundleDownload(id) {
    var existing = bdlEntry(id);
    if (existing && existing.state === 'running') return; // one runner per bundle
    // resolve the member list: the open bunch view's groups when they're
    // loaded (the button only lives there), else the collection endpoint.
    var groupsPromise = (bcur && bcur.id === id && bcur.groups && !bcur.loading)
      ? Promise.resolve(bcur.groups)
      : api('GET', '/api/hub/collections/' + encodeURIComponent(id) + '/items')
        .then(function (d) { return (d && d.groups) || []; });
    groupsPromise.then(function (groups) {
      var members = [];
      (groups || []).forEach(function (g) {
        (g.items || []).forEach(function (it) {
          if (it && it.repo && it.id) members.push({ type: g.type || it.type, repo: it.repo, id: it.id });
        });
      });
      if (!members.length) throw new Error('the bundle has no downloadable members');
      // seed the session's downloaded map for every member type FIRST
      // (seedLocalState only runs for browsed libraries) — a resume
      // after an app restart then SKIPS the already-downloaded members
      // instead of re-POSTing them (the engine counts a metric per
      // download POST, so a blind resume would inflate the counts).
      var types = {};
      members.forEach(function (m) { if (m.type) types[m.type] = true; });
      var seeds = Object.keys(types).map(function (t) { return seedLocalState(t); });
      var entry = { state: 'running', done: 0, total: members.length, failed: 0, lastErr: '', at: Date.now() };
      bdlSet(id, entry);
      paintDlPill();
      Promise.all(seeds).then(function () { start(); });
      function start() {
      var queue = members.slice();
      var inFlight = 0;
      function finish() {
        entry.at = Date.now();
        entry.state = (entry.failed === 0) ? 'done' : ((entry.done || 0) > (entry.failed || 0) ? 'partial' : 'error');
        bdlSet(id, entry);
        paintDlPill();
        toast(
          entry.state === 'done' ? 'downloaded ' + entry.total + ' items — the whole bundle is yours'
          : entry.state === 'partial' ? 'downloaded ' + ((entry.done || 0) - (entry.failed || 0)) + '/' + entry.total +
            ' — ' + entry.failed + ' failed (resume to retry them)'
          : 'the bundle download failed' + (entry.lastErr ? ' — ' + entry.lastErr : ''),
          entry.state === 'done' ? undefined : { ms: 3400 }
        );
        if (bunchTop() && bcur && bcur.id === id) bunchRepaint();
      }
      function dlOne(m) {
        // already downloaded this session (the map is seeded from the
        // engine's rows) — counts instantly, no request, no re-metric.
        if (isDownloaded(m.type, m.repo, m.id)) {
          entry.done = (entry.done || 0) + 1;
          bdlSet(id, entry);
          paintDlPill();
          return Promise.resolve();
        }
        return api('POST', '/api/hub/' + encodeURIComponent(m.type) + '/download',
            { repo: m.repo, id: m.id })
          .then(function (d) {
            var it = (d && d.item) || { type: m.type, repo: m.repo, id: m.id };
            var payload = (d && d.payload) || '';
            markDownloaded(m.type, m.repo, m.id);
            applyHubSideEffects(m.type, it, payload);
            entry.done = (entry.done || 0) + 1;
          })
          .catch(function (err) {
            entry.done = (entry.done || 0) + 1;
            entry.failed = (entry.failed || 0) + 1;
            entry.lastErr = (err && err.message) || 'a member failed';
          })
          .then(function () {
            entry.at = Date.now();
            bdlSet(id, entry);
            paintDlPill();
          });
      }
      function tick() {
        while (inFlight < 3 && queue.length) {
          var m = queue.shift();
          inFlight++;
          dlOne(m).then(function () { inFlight--; tick(); });
        }
        if (!queue.length && inFlight === 0) finish();
      }
      tick();
      }
      // (end start — the seeded fan-out)
    }).catch(function (e) {
      toast((e && e.message) || 'the bundle download failed');
    });
  }

  function collectTags(items) {
    var seen = {}, out = [];
    (items || []).forEach(function (it) {
      (it.tags || []).forEach(function (t) {
        if (t && !seen[t]) { seen[t] = true; out.push(t); }
      });
    });
    return out.sort();
  }

  // ── rendering ────────────────────────────────────────────────────
  // isTop(): is the hub view the one currently shown? Async callbacks
  // (search debounce, tab switches, the post-publish refresh) may resolve
  // AFTER another view was stacked over the hub — updating then would
  // clobber the user's current view, so they no-op instead.
  function isTop() {
    return !!(cur && cur.panel && cur.viewObj &&
      typeof cur.panel.topView === 'function' && cur.panel.topView() === cur.viewObj);
  }

  // the live-DOM accessors — every update is SURGICAL (the search input
  // is never re-rendered, so the keyboard stays up while results stream)
  function q(sel) {
    return (cur && cur.panel && cur.panel.bodyEl) ? cur.panel.bodyEl.querySelector(sel) : null;
  }
  function zone() { return q('#hub-bodyzone'); }

  function shortLabel(lib) {
    return String(lib.label || lib.type || '').replace(/\s*library\s*$/i, '');
  }

  function buildView() {
    var v = view('public library', function () { return renderHTML(); },
      function (el) { wire(el); },
      function () { onClosed(); });
    if (cur) cur.viewObj = v; // isTop()'s identity check
    return v;
  }

  // v0.56 (user spec item 9): the sort pills' ICONS — the old text
  // columns (recent / downloads / endorsements / relevant + the filter
  // funnel + the redundant filter-by-text box) are GONE; the freed space
  // rides the search row as little icon buttons.
  var SORT_ICONS = { recent: 'zap', downloads: 'download', hearts: 'heart', relevant: 'sparkles' };

  function renderHTML() {
    if (!cur) return '';
    return (
      '<div class="hub-root" data-tone="' + escAttr(cur.type || '') + '">' +
        // v0.52: the chat-connection pill — the library's ONLY binding to
        // a chat (decoupled by default: "no chat" unless a chatbot opened
        // it). Tap → the merged all-chats overlay in pick mode.
        '<div class="hub-chatrow">' + chatPillHTML() + '</div>' +
        topDockHTML() +
        headBodyHTML() +
        '<div class="hub-bodyzone" id="hub-bodyzone">' + bodyHTML() + '</div>' +
      '</div>'
    );
  }

  // v0.56 (user spec item 9): THE TOP DOCK — the pinned library chrome.
  // When you scroll, the collapsed "Public Library" header pill stays
  // pinned and the search bar + sort icons collapse to a round search
  // icon; tapping it expands the row again (and focuses the input). The
  // dock blends with the panel behind (surface-1 glass + blur) — NOT the
  // overlay background (user spec: "not use the overlay background color
  // and use something else. Something that would blend with the rest of
  // the background").
  function topDockHTML() {
    var c = cur;
    var status = '<span class="pub-status" id="pub-status">' + statusHTML() + '</span>';
    var ico = (window.IconLib && window.IconLib.has('search'))
      ? window.IconLib.svg('search', 15) : '⌕';
    return (
      '<div class="hub-topdock" id="hub-topdock">' +
        '<div class="pub-head-bar" id="pub-head-toggle" role="button" tabindex="0"' +
          ' aria-expanded="' + (!c.folded) + '">' +
          '<span class="pub-title">Public Library</span>' +
          status +
          '<span class="pub-chev" aria-hidden="true">' + (c.folded ? '▸' : '▾') + '</span>' +
        '</div>' +
        '<div class="hub-dockrow" id="hub-dockrow">' +
          '<button type="button" class="hub-searchico" id="hub-searchico" aria-label="Search the library" title="Search">' + ico + '</button>' +
          '<input id="hub-search" class="hub-search" type="text" inputmode="search"' +
            ' placeholder="search name, description, tags…" value="' + escAttr(cur.q) + '"' +
            ' aria-label="search the library">' +
          sortIconsHTML() +
        '</div>' +
        '<div class="hub-fsub" id="hub-fsub">' + fsubHTML() + '</div>' +
      '</div>');
  }

  function sortIconsHTML() {
    var c = cur;
    var out = '';
    SORTS.forEach(function (s) {
      var g = (window.IconLib && window.IconLib.has(SORT_ICONS[s.key]))
        ? window.IconLib.svg(SORT_ICONS[s.key], 15) : '';
      out += '<button type="button" class="hub-sortico" data-sort="' + escAttr(s.key) + '"' +
        (s.key === c.sort ? ' data-on="1"' : '') +
        ' title="' + escAttr(s.label + ' — ' + s.sub) + '" aria-label="sort by ' + escAttr(s.label) + '">' +
        g + '</button>';
    });
    return '<div class="hub-sortrow" id="hub-sortrow">' + out + '</div>';
  }

  function fsubHTML() {
    var c = cur;
    return esc(SORT_SUB[c.sort] || '');
  }

  // the collapsible header body — everything that ISN'T the pinned dock:
  // "Browse the community for:" + the full-row library pills + the grid
  // steppers + publish + the tag pills. Folds under the pinned bar.
  function headBodyHTML() {
    var c = cur;
    return (
      '<div class="pub-head-body' + (c.folded ? ' folded' : '') + '" id="pub-head-body">' +
        '<div class="pub-sub">Browse the community for:</div>' +
        '<div class="hub-librow" id="hub-libs">' + libsHTML() + '</div>' +
        '<div class="hub-ctlrow">' +
          stepper('cols', c.grid.cols, 1, 5) +
          stepper('rows', c.grid.rows, 3, 100) +
          // v0.58 (user spec pt 4): the show-bundles toggle — rides between
          // the steppers and the publish pill; ON = bundle cards shown (their
          // member items hidden), OFF = plain items only.
          bundlesToggleHTML() +
          '<button class="hub-publish" id="hub-publish">＋ publish</button>' +
        '</div>' +
        '<div class="hub-pillrow" id="hub-tags">' + tagsHTML() + '</div>' +
      '</div>');
  }

  function libsHTML() {
    var c = cur;
    var out = '';
    c.libraries.forEach(function (lib) {
      var active = lib.type === c.type;
      var label = shortLabel(lib) + 's';
      out += '<button type="button" class="hub-libpill" data-lib="' + escAttr(lib.type) + '"' +
        ' data-tone="' + escAttr(lib.type) + '"' +
        (active ? ' data-on="1"' : '') +
        ' title="' + escAttr(lib.desc || '') + '">' +
        '<span class="dx-pill-ico">' + libIcon(lib.type) + '</span>' +
        '<span class="dx-pill-label">' + esc(label) + '</span>' +
        (active && c.items && !c.loading && c.items.length
          ? '<span class="hub-libpill-count">' + c.items.length + '</span>' : '') +
        '</button>';
    });
    if (!out) {
      out = '<span class="hub-libpill hub-libpill-ghost">' +
        esc(c.libErr || 'no libraries registered') + '</span>';
    }
    return out;
  }

  function statusHTML() {
    var a = cur.auth;
    if (!a || !a.connected) return '';
    return 'HF: <b>' + esc(a.username || '?') + '</b>' +
      ' <button type="button" data-disconnect="1" title="disconnect the Hugging Face token">disconnect</button>';
  }

  // v0.49 → v0.56 RETIRED: the filter row (funnel + the 4 text sort
  // columns + the filter-by-text box) is gone — the sort columns are
  // ICONS riding the search row now (sortIconsHTML) and the text filter
  // duplicated the search bar (user spec: "remove the unnecessary
  // filter").

  function tagsHTML() {
    var c = cur;
    var out = '';
    c.tags.forEach(function (t) {
      out += '<button type="button" class="dx-pill dx-pill--sm" data-tag="' + escAttr(t) + '"' +
        (t === c.tag ? ' data-on="1"' : '') + '>#' + esc(t) + '</button>';
    });
    return out;
  }

  function bodyHTML() {
    var c = cur;
    // v0.58 (user spec pt 8): MY-xyz — the my-pill filters the grid to the
    // user's downloads (client-side q + sort over the downloads list).
    // (v0.60 pt B: the BUNCH view is its own pushed view now — the grid
    // below only ever renders the library/mine lists.)
    // v0.60 pt C.6: the mine view GROUPS BY BUNDLE — one section per
    // collection (everything-is-a-bundle: published items self-bundle),
    // loose downloads trail at the end; each bundle header carries a 🗑
    // (delete-your-copy, with the keep/remove confirm bar).
    if (c.mine) {
      if (c.mineLoading) return '<div class="art-loading">loading your downloads…</div>';
      var mine = mineVisible(c);
      if (!mine.length) {
        return '<div class="hub-empty">nothing downloaded yet — browse the community and grab something</div>';
      }
      var groups = {}, order = [];
      mine.forEach(function (it) {
        var key = String(it.collection || '');
        if (!groups[key]) { groups[key] = []; order.push(key); }
        groups[key].push(it);
      });
      order.sort(function (a, b) {
        return groups[b].length - groups[a].length || (a || 'zzzz').localeCompare(b || 'zzzz');
      });
      var mp = minePage(c, mine);
      var mout = '';
      order.forEach(function (key) {
        var members = groups[key];
        // v0.63 (user spec pt 4): mine sections collapse too — same
        // chevron header as the bunch view (collapsed by default).
        var mOpen = !!(c.mineOpen && c.mineOpen[key]);
        var secCls = 'hub-bunch-sec' + (mOpen ? '' : ' folded');
        var secAttrs = ' data-msec="' + escAttr(key) + '"';
        if (key) {
          mout += '<div class="' + secCls + '"' + secAttrs + '>' +
            '<div class="hub-bunch-sec-h" role="button" tabindex="0" aria-expanded="' + (mOpen ? 'true' : 'false') + '">' + libIcon(c.type) + ' <span class="hub-mine-bundle">' + esc(key) + '</span>' +
              ' <span class="hub-bunch-sec-n">' + members.length + '</span>' +
              '<span class="hub-sec-chev" aria-hidden="true">▸</span>' +
              '<button type="button" class="hub-group-del" data-gdel="' + escAttr(key) + '"' +
                ' title="delete this bundle\'s copies" aria-label="delete the bundle">🗑</button>' +
            '</div>' +
            '<div class="hub-grid" style="--hub-cols:' + mp.eff + '">' +
              members.map(cardHTML).join('') +
            '</div>' +
          '</div>';
        } else {
          mout += '<div class="' + secCls + '"' + secAttrs + '>' +
            '<div class="hub-bunch-sec-h" role="button" tabindex="0" aria-expanded="' + (mOpen ? 'true' : 'false') + '">' + libIcon(c.type) + ' loose downloads' +
              ' <span class="hub-bunch-sec-n">' + members.length + '</span>' +
              '<span class="hub-sec-chev" aria-hidden="true">▸</span></div>' +
            '<div class="hub-grid" style="--hub-cols:' + mp.eff + '">' +
              members.map(cardHTML).join('') +
            '</div>' +
          '</div>';
        }
      });
      // the bundle-delete confirm bar (sticky at the body zone's bottom).
      if (c.mineConfirm) {
        mout += '<div class="hi-delbar hub-mine-delbar" id="hub-mine-delbar" role="alertdialog" aria-label="confirm bundle delete">' +
          '<span class="hi-delbar-text">Remove every <b>' + esc(c.mineConfirm) + '</b> download from this device?</span>' +
          '<button type="button" class="hi-delbar-btn" data-mdel="keep">keep</button>' +
          '<button type="button" class="hi-delbar-btn hi-delbar-btn--rm" data-mdel="remove">remove</button>' +
        '</div>';
      }
      return mout;
    }
    var eff = clampCols(c.grid, c.width);
    c.eff = eff;
    var per = eff * c.grid.rows;
    // v0.60 pt C.9: bundles are always the grid
    var showBundles = true;
    // v0.67.4: items===null means the fetch never landed (still loading,
    // or loadItems never fired — the isTop() race). The OLD code fell
    // through to "nothing here" with a null list — the page-1/1-empty /
    // "returns nothing when it should return stuff" report. Loading is
    // the only honest render for that state.
    if (c.items === null) {
      return '<div class="art-loading">loading the library…</div>';
    }
    // v0.67.4: the members hide ONLY behind bunch cards that ACTUALLY
    // render — while the collections fetch is in flight (bunchLoading)
    // or failed/empty, a member whose bunch card isn't on screen renders
    // as a normal card. The old blanket filter (every it.collection
    // hidden, bunch cards maybe missing) produced the empty-grid-page-
    // 1/1 hole: real items vanished behind bunches that never painted.
    var bunches = (showBundles && !c.bunchLoading) ? (c.collections || []).filter(function (b) {
      return ((b && b.byType) || {})[c.type] > 0;
    }) : [];
    var renderedBunch = {};
    bunches.forEach(function (b) { renderedBunch[b.id] = true; });
    var items = (c.items || []).filter(function (it) {
      return !it || !it.collection || !renderedBunch[SaniCollectionKey(it.collection)];
    });
    var pages = Math.max(1, Math.ceil(items.length / per));
    var page = Math.min(Math.max(1, c.page), pages);
    c.page = page;

    if (c.loading && !c.items) return '<div class="art-loading">loading the library…</div>';
    if (!items.length && !bunches.length) {
      // v0.67.4: the bunches still streaming is a LOADING state, not
      // "nothing here" — a type whose items are all bundle members (the
      // skills library is exactly that) used to flash the wrong empty
      // message between the two fetches. An error keeps its message +
      // gains a retry pill; a clean empty keeps the old guidance.
      if (!c.err && showBundles && c.bunchLoading) {
        return '<div class="art-loading">loading the library…</div>';
      }
      return '<div class="hub-empty">' +
        (c.err ? esc(c.err) + ' — ' : '') +
        (c.err
          ? '<button type="button" class="hub-empty-retry" id="hub-retry">↻ retry</button>'
          : 'nothing here' + (c.q ? ' for \u201c' + esc(c.q) + '\u201d' : '') +
            ' \u2014 try another search, another tag, or publish something below') +
        '</div>';
    }
    return (
      '<div class="hub-grid" id="hub-grid" style="--hub-cols:' + eff + '">' +
          bunches.map(collectionCardHTML).join('') +
          items.slice((page - 1) * per, page * per).map(cardHTML).join('') +
      '</div>' +
      pagerHTML(page, pages)
    );
  }

  // v0.67.4: the client twin of the engine's SanitizeCollection — a
  // member's collection id and the bunch card's id must meet on the
  // SAME normalized key or the renderedBunch check misses. Mirrors
  // model.go's SanitizeIcon slug exactly: lowercase, [^a-z0-9]+ → '-',
  // trim edges, cap at 24 (MaxTagLen) then trim again.
  function SaniCollectionKey(raw) {
    var out = String(raw || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (out.length > 24) out = out.slice(0, 24).replace(/^-+|-+$/g, '');
    return out;
  }

  function pagerHTML(page, pages) {
    return (
      '<div class="hub-pager">' +
        '<button class="hub-nav" data-page="prev"' + (page <= 1 ? ' disabled' : '') + ' aria-label="previous page">‹</button>' +
        '<span class="hub-page-line">page ' + page + '/' + pages + '</span>' +
        '<button class="hub-nav" data-page="next"' + (page >= pages ? ' disabled' : '') + ' aria-label="next page">›</button>' +
      '</div>'
    );
  }

  // v0.58: the my-xyz list — client-side q filter + sort over downloads.
  function mineVisible(c) {
    var list = (c.mineItems || []).slice();
    var lq = String(c.q || '').toLowerCase();
    if (lq) {
      list = list.filter(function (it) {
        return (it.name || '').toLowerCase().indexOf(lq) >= 0 ||
          (it.description || '').toLowerCase().indexOf(lq) >= 0 ||
          (it.tags || []).some(function (t) { return (t || '').toLowerCase().indexOf(lq) >= 0; });
      });
    }
    var key = c.sort === 'downloads' ? 'downloads' : (c.sort === 'hearts' ? 'hearts' : 'updatedAt');
    list.sort(function (a, b) {
      if (key !== 'updatedAt') return (b[key] || 0) - (a[key] || 0);
      return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
    });
    return list;
  }
  function minePage(c, mine) {
    var eff = clampCols(c.grid, c.width);
    c.eff = eff;
    var per = eff * c.grid.rows;
    var pages = Math.max(1, Math.ceil(mine.length / per));
    var page = Math.min(Math.max(1, c.page), pages);
    c.page = page;
    return { eff: eff, per: per, page: page, pages: pages };
  }

  function stepper(kind, val, lo, hi) {
    return '<span class="hub-ctl" data-ctl="' + escAttr(kind) + '">' +
      '<button class="hub-step" data-step="' + escAttr(kind) + ':-1"' + (val <= lo ? ' disabled' : '') +
        ' aria-label="fewer ' + esc(kind) + '">' + (kind === 'cols' ? '‹' : '−') + '</button>' +
      '<span class="hub-step-val" id="hub-' + escAttr(kind) + '-val">' + val + '</span>' +
      '<button class="hub-step" data-step="' + escAttr(kind) + ':1"' + (val >= hi ? ' disabled' : '') +
        ' aria-label="more ' + esc(kind) + '">' + (kind === 'cols' ? '›' : '＋') + '</button>' +
    '</span>';
  }

  // v0.60 pt C.9: the bundles toggle is GONE — every item is a bundle
  // (the auto-collection), so the grid always shows the bundle cards and
  // the members live inside the pushed bunch view.
  function bundlesToggleHTML() {
    return '';
  }

  // ── v0.52: themed stat glyphs (bigger ♥ / ⤓ — user spec item 4). The
  // heart FILLS when hearted (fill=currentColor over the stroke).
  function statIcon(name, filled) {
    var I = window.IconLib;
    if (!I || !I.has(name)) return '';
    var s = I.svg(name, 17);
    if (filled) s = s.replace('fill="none"', 'fill="currentColor"');
    return s;
  }
  function heartGlyph(on) { return statIcon('heart', on) || (on ? '♥' : '♡'); }
  function dlGlyph() { return statIcon('download', false) || '⤓'; }

  function findItem(id) {
    if (!cur) return null;
    var i, j;
    if (cur.items) {
      for (i = 0; i < cur.items.length; i++) {
        if (cur.items[i].id === id) return cur.items[i];
      }
    }
    // v0.58: the my-xyz filter renders items cur.items never held
    if (cur.mineItems) {
      for (i = 0; i < cur.mineItems.length; i++) {
        if (cur.mineItems[i].id === id) return cur.mineItems[i];
      }
    }
    // v0.60 pt B: bunch members live in the BUNCH VIEW's groups
    var groups = (bcur && bcur.groups) || [];
    for (i = 0; i < groups.length; i++) {
      var items = groups[i].items || [];
      for (j = 0; j < items.length; j++) {
        if (items[j].id === id) return items[j];
      }
    }
    return null;
  }

  function cardHTML(it) {
    var sub = it.description ||
      (it.tags || []).map(function (t) { return '#' + t; }).join(' ') ||
      '—';
    // v0.52 (user spec item 3): the icon COLUMN left of the name —
    // optional; no icon renders exactly the pre-v0.52 layout.
    // v0.61 (icons): a file:<path> icon renders the item's own art file.
    var ico = (it.icon && window.IconLib) ? window.IconLib.card(it.icon, it.repo, 20) : '';
    var hearted = isHearted(it.type || (cur && cur.type), it.repo, it.id);
    // v0.58 (user spec pt 10): "~x stages" rides the foot, right of the
    // downloads with a two-tab gap — templates with a deterministic count.
    var isTpl = (it.type || (cur && cur.type)) === 'template';
    var stages = (isTpl && it.stageCount > 0)
      ? '<span class="hub-card-stat hub-card-stat--stages">~' + it.stageCount + ' stages</span>' : '';
    return (
      '<button class="hub-card" data-item="' + escAttr(it.id) + '">' +
        '<span class="hub-card-bg" data-bgcard="1"></span>' +
        '<span class="hub-card-fade"></span>' +
        '<span class="hub-card-body">' +
          '<span class="hub-card-titlerow">' +
            (ico ? '<span class="hub-card-ico" aria-hidden="true">' + ico + '</span>' : '') +
            '<span class="hub-card-name"><span class="hub-card-name-in">' + esc(it.name) + '</span></span>' +
          '</span>' +
          '<span class="hub-card-desc">' + esc(sub) + '</span>' +
          '<span class="hub-card-author">by ' + esc(it.author || 'unknown') + creditSuffix(it.upstream) + '</span>' +
          '<span class="hub-card-foot">' +
            '<span class="hub-card-stat' + (hearted ? ' on' : '') + '" data-heart="1" role="button"' +
              ' tabindex="0" aria-label="endorse">' + heartGlyph(hearted) + '<b>' + (it.hearts || 0) + '</b></span>' +
            '<span class="hub-card-stat">' + dlGlyph() + '<b>' + (it.downloads || 0) + '</b></span>' +
            stages +
          '</span>' +
        '</span>' +
      '</button>'
    );
  }

  // v0.58 (user spec pt 6): long names MARQUEE — the inner span slowly
  // slides across when the name overflows its line (see marqueeScan).
  function marqueeScan(host) {
    var scope = host || (cur && cur.panel ? cur.panel.bodyEl : document);
    if (!scope || !scope.querySelectorAll) return;
    scope.querySelectorAll('.hub-card-name').forEach(function (n) {
      var inner = n.firstElementChild;
      if (!inner || n.classList.contains('marquee')) return;
      var over = inner.scrollWidth - n.clientWidth;
      if (over > 8) {
        n.classList.add('marquee');
        n.style.setProperty('--slide-d', -over + 'px');
        n.style.setProperty('--slide-t', Math.max(4, Math.round(over / 26)) + 's');
      }
    });
  }

  // v0.52 (user spec item 1): the BUNCH card — one grouped listing for a
  // whole collection. v0.58 (user spec pt 2): the bunch is now a FULL card
  // — bg art (the engine resolves design: curated override → newest member
  // design → the deterministic hash fallback) + a horizontal FOR-SALE-STYLE
  // FLAG on the left edge showing "#tag" + a smaller "bundle". Tap opens
  // the cross-library member view.
  function collectionCardHTML(b) {
    var I = window.IconLib;
    // v0.61 (icons): the bunch icon may be a file:<path> art file (the
    // summary carries the contributor's repo).
    var ico = I ? (I.card(b.icon, b.repo, 22) || I.svg('package', 22)) : '';
    var bits = [];
    var byType = b.byType || {};
    Object.keys(byType).forEach(function (t) {
      bits.push(byType[t] + ' ' + (shortType(t)) + (byType[t] === 1 ? '' : 's'));
    });
    var flag = (b.tag || '').trim()
      ? '<span class="hub-bundle-flag"' + flagStyle(b) + '><b>#' + esc(String(b.tag).trim()) +
        '</b></span>' : '';
    return (
      '<button class="hub-card hub-card--bunch" data-bunch="' + escAttr(b.id) + '">' +
        '<span class="hub-card-bg" data-bunchbg="1"></span>' +
        '<span class="hub-card-fade"></span>' +
        '<span class="hub-card-body">' +
          '<span class="hub-card-titlerow">' +
            (ico ? '<span class="hub-card-ico" aria-hidden="true">' + ico + '</span>' : '') +
            '<span class="hub-card-name"><span class="hub-card-name-in">' + esc(b.id) + '</span></span>' +
          '</span>' +
          '<span class="hub-card-desc">' + esc(b.members + ' bundled items — ' + bits.join(' · ')) + '</span>' +
          '<span class="hub-card-foot">' +
            '<span class="hub-card-stat">' + heartGlyph(false) + '<b>' + (b.hearts || 0) + '</b></span>' +
            '<span class="hub-card-stat">' + dlGlyph() + '<b>' + (b.downloads || 0) + '</b></span>' +
          '</span>' +
        '</span>' +
        flag +
      '</button>'
    );
  }

  // v0.58: the flag's paint — an opaque solid from the bunch's own design
  // (its first stop), else the deterministic hash color; ink flips by
  // luminance so the text always reads. This is per-item CONTENT data (the
  // same rule as card art), not UI chrome — chrome stays on theme vars.
  // v0.71: THE FLAG MIRRORS THE CARD — the badge used to wear only the
  // design's FIRST STOP (a flat amber chip on superpowers' amber→red→
  // violet mesh read as unrelated to the card under it). The badge now
  // paints the SAME art the card paints (the full design through
  // GradientUI — mesh/multi-stop/texture, blend mode included — else the
  // bunch's deterministic hash gradient), so "#xyz bundle" always reads
  // as belonging to its card. Ink flips by the AVERAGE luminance of the
  // stops (a mesh's first stop can be the lightest/darkest outlier).
  function flagStyle(b) {
    var d = b.design || {};
    var paint = '', ref = '';
    if (d.kind === 'gradient' && d.colors && d.colors.length) {
      var GU = window.GradientUI;
      var css = GU ? GU.css({ colors: d.colors, dir: d.dir, angle: d.angle, tex: d.tex }) : '';
      if (css) {
        paint = 'background:' + css + ';' +
          ((d.tex && GU.BLENDED) ? 'background-blend-mode:color;' : '');
      } else if (d.colors.length === 1) {
        paint = 'background:' + d.colors[0] + ';';
      } else {
        paint = 'background:linear-gradient(135deg, ' + d.colors.join(', ') + ');';
      }
      ref = d.colors.join(',');
    }
    if (!paint) paint = 'background:' + idGradient(b.id) + ';';
    if (!ref) ref = idColors(b.id).join(',');
    var ink = '#fff', shadow = '0 1px 4px rgba(0,0,0,0.55)';
    // the average luminance across every parseable stop (hex only —
    // hsl/rgb specs fall back to the light-ink default, same as before)
    var lum = 0, n = 0;
    String(ref).split(',').forEach(function (c) {
      var m = /^#([0-9a-f]{6})$/i.exec(String(c).trim());
      if (!m) return;
      lum += 0.299 * parseInt(m[1].slice(0, 2), 16) +
             0.587 * parseInt(m[1].slice(2, 4), 16) +
             0.114 * parseInt(m[1].slice(4, 6), 16);
      n++;
    });
    if (n && lum / n > 168) {
      ink = 'rgba(10,10,14,0.92)'; shadow = '0 1px 3px rgba(255,255,255,0.35)';
    }
    return ' style="' + paint + 'color:' + ink + ';text-shadow:' + shadow + '"';
  }

  // v0.58: the bunch card's art layer — like paintCardBg but png designs
  // (member uploads) fall back to the hash gradient (no png endpoint for
  // a bunch).
  function paintBunchBg(bgEl, b) {
    var d = b.design || {};
    if (d.kind === 'gradient' && d.colors && d.colors.length >= 1) {
      var GU = window.GradientUI;
      if (GU) {
        var css = GU.css({ colors: d.colors, dir: d.dir, angle: d.angle, tex: d.tex });
        if (css.charAt(0) === '#') bgEl.style.backgroundColor = css;
        else {
          bgEl.style.backgroundImage = css;
          if (d.tex && GU.BLENDED) bgEl.style.backgroundBlendMode = 'color';
        }
        return;
      }
      if (d.colors.length === 1) { bgEl.style.backgroundColor = d.colors[0]; return; }
      bgEl.style.backgroundImage = 'linear-gradient(135deg, ' + d.colors.join(', ') + ')';
      return;
    }
    bgEl.style.backgroundImage = idGradient(b.id);
  }

  function shortType(t) {
    return { persona: 'persona', template: 'template', skill: 'skill', theme: 'theme', script: 'script', doc: 'doc' }[t] || t;
  }

  // The card's background layer: a v0.44 design SPEC (the shared
  // gradient system — 1–15 stops, dir / angle / an optional texture
  // dataURL blended in with background-blend-mode: color; legacy rows
  // without dir render exactly as before: 'auto' = the 135° linear
  // sweep — one stop renders solid) → PNG (probed, fading 100→0 alpha
  // into the card surface) → deterministic id gradient.
  function paintCardBg(bgEl, it) {
    var d = it.design || {};
    if (d.kind === 'gradient' && d.colors && d.colors.length >= 1) {
      var GU = window.GradientUI;
      if (GU) {
        var css = GU.css({ colors: d.colors, dir: d.dir, angle: d.angle, tex: d.tex });
        if (css.charAt(0) === '#') {
          bgEl.style.backgroundColor = css;   // one stop + no texture = a solid
        } else {
          bgEl.style.backgroundImage = css;   // the tex dataURL rides as the bottom layer
          if (d.tex && GU.BLENDED) bgEl.style.backgroundBlendMode = 'color';
        }
        return;
      }
      // no uikit — the v0.33 render
      if (d.colors.length === 1) {
        bgEl.style.backgroundColor = d.colors[0]; // one stop = a solid
      } else {
        bgEl.style.backgroundImage = 'linear-gradient(135deg, ' + d.colors.join(', ') + ')';
      }
      return;
    }
    if (d.kind === 'png') {
      var url = '/api/hub/' + encodeURIComponent(it.type) + '/png/' +
        encodeURIComponent(it.repo) + '/' + encodeURIComponent(it.id);
      var probe = new Image();
      probe.onload = function () {
        // the fade mask paints OVER the image (first layer on top)
        bgEl.style.backgroundImage =
          'linear-gradient(to top, var(--surface-1) 0%, transparent 55%), url("' + url + '")';
      };
      probe.onerror = function () { bgEl.style.backgroundImage = idGradient(it.id); };
      probe.src = url;
      return;
    }
    bgEl.style.backgroundImage = idGradient(it.id);
  }

  // ── SURGICAL updates (the keyboard-safe replacement for replaceView) ──
  function updateLibs() {
    var el = q('#hub-libs');
    if (!el) return;
    el.innerHTML = libsHTML();
    wireLibs(el);
    // v0.58: cur.type resolves ASYNC (fetchLibraries) — after it lands the
    // chrome re-tones + the my-xyz pill relabels (the initial render had
    // no type yet).
    var rootEl = (cur && cur.panel && cur.panel.bodyEl) ? cur.panel.bodyEl.querySelector('.hub-root') : null;
    if (rootEl && cur.type && rootEl.getAttribute('data-tone') !== cur.type) {
      rootEl.setAttribute('data-tone', cur.type);
      updateChatrow();
    }
  }
  function updateTags() {
    var el = q('#hub-tags');
    if (!el) return;
    el.innerHTML = tagsHTML();
    wireTags(el);
  }
  function updateStatus() {
    var el = q('#pub-status');
    if (!el) return;
    el.innerHTML = statusHTML();
    var dc = el.querySelector('[data-disconnect]');
    if (dc) dc.addEventListener('click', function () {
      api('POST', '/api/hub/auth/disconnect').then(function () {
        toast('disconnected from Hugging Face');
        if (cur) { cur.auth = null; loadAuth(); }
      }).catch(function (e) { toast(e.message || 'could not disconnect'); });
    });
  }
  function updateFilters() {
    var c = cur;
    // v0.56: the sort ICONS (the old #hub-fcols text columns are gone) —
    // surgical data-on swap + the fsub line (the sort hint).
    var root = (cur && cur.panel) ? cur.panel.bodyEl : null;
    if (root) {
      root.querySelectorAll('[data-sort]').forEach(function (b) {
        if (b.getAttribute('data-sort') === c.sort) b.setAttribute('data-on', '1');
        else b.removeAttribute('data-on');
      });
    }
    var sub = q('#hub-fsub');
    if (sub) sub.innerHTML = fsubHTML();
  }

  function updateBody() {
    var z = zone();
    if (!z) return;
    z.innerHTML = bodyHTML();
    wireBody(z);
    marqueeScan(z);   // v0.58: measure the long names after the paint
  }

  // v0.58 (user spec pt 8): refresh the chat row (the my-xyz pill follows
  // the browsed type + its on/off state).
  function updateChatrow() {
    var el = q('.hub-chatrow');
    if (!el) return;
    el.innerHTML = chatPillHTML();
    wireChatPill(el);
  }

  // ── wiring ───────────────────────────────────────────────────────
  function wire(el) {
    if (!cur) return;
    var c = cur;

    // v0.52: the chat-connection pill + the NEUTRAL header. While the
    // library view is up, the panel header stops showing the HOST
    // chat's avatar/sub (the library is not bound to it) — a library
    // glyph + "community library" ride instead. The panel's root
    // restore puts the chat's values back when the view pops.
    wireChatPill(el);
    try {
      var p = c.panel;
      if (p && p.avatarEl && p.subEl) {
        c._savedAvatar = p.avatarEl.innerHTML;
        c._savedSub = p.subEl.textContent;
        c._hadHeader = true;
        p.avatarEl.innerHTML = '📚';
        p.subEl.textContent = 'community library';
      }
    } catch (e) {}

    // measure now that the view is in the DOM — the clamp may disagree
    // with what the render assumed; a surgical body update fixes it.
    var gridEl = el.querySelector('#hub-grid');
    c.width = (gridEl && gridEl.clientWidth) || el.clientWidth || 320;
    if (gridEl && (gridEl.style.getPropertyValue('--hub-cols') | 0) !== clampCols(c.grid, c.width)) {
      updateBody();
    }

    // the collapsible header — a class toggle, no re-render (the bar is
    // a div: the disconnect button inside forbids a nested <button>).
    // v0.56: the bar lives in the pinned dock; the BODY folds below it.
    var toggle = el.querySelector('#pub-head-toggle');
    if (toggle) {
      var fold = function () {
        var head = q('#pub-head-body');
        if (!head) return;
        c.folded = !c.folded;
        head.classList.toggle('folded', c.folded);
        var chev = q('.pub-chev');
        if (chev) chev.textContent = c.folded ? '▸' : '▾';
        toggle.setAttribute('aria-expanded', String(!c.folded));
        saveHubstate(); // v0.60 pt B
      };
      toggle.addEventListener('click', fold);
      toggle.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fold(); }
      });
    }

    // v0.56 (user spec item 9): THE SCRUNCH — on scroll, the pinned dock
    // collapses its search row to a round search icon; tapping the icon
    // (or scrolling back to the top) expands it again.
    var rootEl = el.querySelector('.hub-root') || el;
    var searchico = el.querySelector('#hub-searchico');
    var setScrunch = function (on) {
      if (!rootEl) return;
      if (on) rootEl.classList.add('scrunch');
      else rootEl.classList.remove('scrunch');
    };
    if (searchico) {
      searchico.addEventListener('click', function () {
        setScrunch(false);
        var si = q('#hub-search');
        if (si) { si.focus(); si.select(); }
      });
    }
    if (!c._onHubScroll) {
      var lastSave = 0;
      c._onHubScroll = function () {
        if (!cur || !cur.panel || !cur.panel.bodyEl) return;
        var st = cur.panel.bodyEl.scrollTop;
        // v0.56: never scrunch while the user is TYPING or has a query —
        // focusing the input can fire a scroll event (scrollIntoView),
        // which immediately re-scrunched the dock the tap just expanded.
        var si = q('#hub-search');
        var typing = si && (document.activeElement === si ||
          String(si.value || '').length > 0);
        setScrunch(st > 24 && !typing);
        // v0.60 pt B: the scroll position persists (throttled — at most
        // one write per 400ms of scrolling).
        var now = Date.now();
        if (now - lastSave > 400) { lastSave = now; saveHubstate(); }
      };
      c.panel.bodyEl.addEventListener('scroll', c._onHubScroll, { passive: true });
    }

    // search (200ms debounce — the model-browser pattern). The input
    // is NEVER replaced: only the body zone re-renders, so focus and
    // the mobile keyboard survive every keystroke.
    var searchTimer = null;
    var searchInput = el.querySelector('#hub-search');
    if (searchInput) {
      searchInput.addEventListener('input', function () {
        if (searchTimer) clearTimeout(searchTimer);
        searchTimer = setTimeout(function () {
          if (!cur) return;
          cur.q = searchInput.value;
          saveHubstate(); // v0.60 pt B: the browse state persists
          loadItems();
        }, 200);
      });
    }

    // v0.56: the filter-by-text box is GONE (it duplicated the search
    // bar — user spec: "remove the unnecessary filter").

    // the sort ICONS — surgical, same data-sort contract as the old
    // text columns
    el.querySelectorAll('[data-sort]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (!cur) return;
        cur.sort = b.getAttribute('data-sort');
        saveHubstate(); // v0.60 pt B
        updateFilters();
        loadItems();
      });
    });

    // library pills + tags + the body zone (cards / pager / publish /
    // steppers all live inside the zones these wire)
    wireLibs(el);
    wireTags(el);
    wireBody(el);
    marqueeScan(el);   // v0.58: the initial grid paint needs a scan too
    var pub = el.querySelector('#hub-publish');
    if (pub) pub.addEventListener('click', function () {
      if (window.HubPublish && cur) window.HubPublish.open(cur.type);
      else toast('the publisher is not available');
    });

    // the resize clamp — only while this view is open
    if (!c._onResize) {
      var t = null;
      c._onResize = function () {
        if (!cur || !cur.panel) return;
        if (t) clearTimeout(t);
        t = setTimeout(function () {
          if (!cur) return;
          var g = zone() && zone().querySelector('#hub-grid');
          var w = (g && g.clientWidth) || (cur.panel.bodyEl && cur.panel.bodyEl.clientWidth) || 320;
          cur.width = w;
          if (g && (g.style.getPropertyValue('--hub-cols') | 0) !== clampCols(cur.grid, w)) {
            updateBody();
          }
        }, 120);
      };
      window.addEventListener('resize', c._onResize);
    }

    // first load / stale refresh (loadAuth repaints itself, guarded)
    if (!c.items || c.stale) loadItems(!!c.stale);
    if (!c.auth) loadAuth();
  }

  // library pills — switching reloads the items for that type (and
  // leaves any open bunch — the pill is the way back to a library grid)
  function wireLibs(root) {
    (root || (cur && cur.panel ? cur.panel.bodyEl : document)).querySelectorAll('[data-lib]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (!cur || b.getAttribute('data-on') === '1') return;
        cur.type = b.getAttribute('data-lib');
        cur.items = null;
        cur.tag = '';
        cur.q = '';
        cur.page = 1;
        cur.mine = false;
        cur.mineItems = null;
        saveHubstate(); // v0.60 pt B
        var si = q('#hub-search');
        if (si) si.value = '';
        // v0.58 (pts 1 + 8): the whole library chrome re-tones to the
        // browsed category + the my-xyz pill relabels (and reloads if on).
        var rootEl = (cur.panel && cur.panel.bodyEl) ? cur.panel.bodyEl.querySelector('.hub-root') : null;
        if (rootEl) rootEl.setAttribute('data-tone', cur.type);
        updateLibs();
        updateTags();
        updateFilters();
        updateChatrow();
        updateBody();
        loadItems();
      });
    });
  }

  // tag pills (tap toggles — inside the collapsible header)
  function wireTags(root) {
    (root || (cur && cur.panel ? cur.panel.bodyEl : document)).querySelectorAll('[data-tag]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (!cur) return;
        var t = b.getAttribute('data-tag');
        cur.tag = (cur.tag === t) ? '' : t;
        saveHubstate(); // v0.60 pt B
        updateTags();
        loadItems();
      });
    });
  }

  // the body zone: cards → item detail, pager, steppers
  function wireBody(root) {
    if (!cur) return;
    var c = cur;
    var host = root || zone();
    if (!host) return;

    // grid steppers (surgical: the val spans + the button states + the
    // body zone — the header itself never re-renders)
    host.querySelectorAll('[data-step]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (!cur) return;
        var parts = b.getAttribute('data-step').split(':');
        var kind = parts[0], dir = parseInt(parts[1], 10) || 0;
        // v0.58: the rows cap finally matches its spec everywhere (3–100 —
        // the old handler clamped at 10 while the UI promised 100).
        var lo = kind === 'cols' ? 1 : 3, hi = kind === 'cols' ? 5 : 100;
        if (kind === 'cols') cur.grid.cols = Math.max(lo, Math.min(hi, cur.grid.cols + dir));
        else cur.grid.rows = Math.max(lo, Math.min(hi, cur.grid.rows + dir));
        saveGrid(cur.grid);
        cur.page = 1;
        var cv = q('#hub-cols-val'), rv = q('#hub-rows-val');
        if (cv) cv.textContent = cur.grid.cols;
        if (rv) rv.textContent = cur.grid.rows;
        var ctl = b.closest('.hub-ctl');
        if (ctl) {
          var minus = ctl.querySelector('[data-step="' + kind + ':-1"]');
          var plus = ctl.querySelector('[data-step="' + kind + ':1"]');
          if (minus) minus.disabled = cur.grid[kind] <= lo;
          if (plus) plus.disabled = cur.grid[kind] >= hi;
        }
        updateBody();
      });
    });

    // pager
    host.querySelectorAll('[data-page]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (!cur || b.disabled) return;
        cur.page += (b.getAttribute('data-page') === 'next') ? 1 : -1;
        cur.page = Math.max(1, cur.page);
        saveHubstate(); // v0.60 pt B
        updateBody();
      });
    });

    // v0.67.4: the empty-state retry — an err'd library gets one tap back
    // to a fresh fetch (the old empty state left the user stuck until a
    // full app restart).
    var retry = host.querySelector('#hub-retry');
    if (retry) retry.addEventListener('click', function () {
      if (!cur) return;
      cur.err = '';
      loadItems(true);
    });


    // cards → item detail · v0.60 pt B: bunch cards OPEN THE PUSHED BUNCH
    // VIEW (the grid beneath keeps its filters/selection/scroll), and the
    // card hearts endorse DIRECTLY (user spec item 6: every heart is live —
    // downloaded items toggle their endorsement right on the card; the
    // engine still 400-guards endorse-before-download, so a heart on a
    // not-yet-downloaded item opens the detail where the download lives).
    var items = c.items || [];
    host.querySelectorAll('[data-item]').forEach(function (b) {
      var id = b.getAttribute('data-item');
      var it = findItem(id) || (function () {
        for (var i = 0; i < items.length; i++) if (items[i].id === id) return items[i];
        return null;
      })();
      if (!it) return;
      b.addEventListener('click', function () {
        if (window.HubItem) window.HubItem.open(it.type || cur.type, it);
      });
      var bg = b.querySelector('[data-bgcard]');
      if (bg) paintCardBg(bg, it);
    });

    host.querySelectorAll('[data-bunch]').forEach(function (b) {
      b.addEventListener('click', function () {
        openBunch(b.getAttribute('data-bunch'));
      });
      // v0.58: the bunch card's own art layer
      var bid = b.getAttribute('data-bunch');
      var bb = (c.collections || []).filter(function (x) { return x && x.id === bid; })[0];
      var bg2 = b.querySelector('[data-bunchbg]');
      if (bg2 && bb) paintBunchBg(bg2, bb);
    });

    // v0.60 pt C.6: the mine view's bundle group deletes — the 🗑 arms the
    // keep/remove confirm bar; the bar's remove hits the collection delete
    // endpoint (all member rows + the client's marks + "Yours" copies).
    host.querySelectorAll('[data-gdel]').forEach(function (b) {
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        if (!cur) return;
        cur.mineConfirm = b.getAttribute('data-gdel');
        updateBody();
      });
    });
    var mbar = host.querySelector('#hub-mine-delbar');
    if (mbar) mbar.querySelectorAll('[data-mdel]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (!cur) return;
        var key = cur.mineConfirm || '';
        cur.mineConfirm = '';
        if (b.getAttribute('data-mdel') === 'remove' && key) { doBundleDelete(key); return; }
        updateBody();
      });
    });

    // v0.63 (user spec pt 4): the MINE sections toggle (collapsed by
    // default — same affordance as the bunch view's sections). The 🗑
    // above stops propagation, so it never folds/unfolds by accident.
    host.querySelectorAll('.hub-bunch-sec-h').forEach(function (h) {
      var sec = h.parentElement;
      if (!sec || !sec.hasAttribute('data-msec')) return;
      var flip = function () {
        if (!cur) return;
        var key = sec.getAttribute('data-msec');
        cur.mineOpen = cur.mineOpen || {};
        cur.mineOpen[key] = !cur.mineOpen[key];
        updateBody();
      };
      h.addEventListener('click', flip);
      h.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flip(); }
      });
    });

    wireCardHearts(host);
  }

  // v0.60 pt C.6: the BUNDLE delete — POST the collection delete endpoint
  // (every member's local row), then clean the client: the session's
  // downloaded/hearted marks + the localStorage "Yours" copies + the mine
  // list itself (reloaded from the engine's now-smaller rows).
  function doBundleDelete(id) {
    toast('removing the bundle…', { hold: true });
    api('POST', '/api/hub/collections/' + encodeURIComponent(id) + '/delete')
      .then(function (d) {
        ((d && d.items) || []).forEach(function (ref) {
          if (!ref) return;
          unmarkDownloadedAll(ref.type, ref.id);
          if (window.TemplateSheet && window.TemplateSheet.removeUserTemplate &&
              (ref.type === 'template' || ref.type === 'skill')) {
            window.TemplateSheet.removeUserTemplate(String(ref.id));
          }
        });
        // v0.67.5: the download registry follows the delete — a bundle
        // whose copies were removed must NOT greet the user as "✓
        // downloaded N" (the pill returns to download-all on the next
        // open).
        try { delete bdlLoad()[id]; bdlSave(); } catch (e) {}
        toast('removed ' + ((d && d.deleted) || 0) + ' items — the bundle is off this device');
        // v0.72: THE PARITY CARD — deleted FROM the bunch view (the 🗑
        // FAB), the view STAYS (the FABs reset: ⤓ idle, ♥ locked); the
        // mine view keeps its own reload-the-list behavior.
        if (bcur && bcur.id === id && bunchTop()) {
          bcur.confirmDel = false;
          bunchRepaint();
          return;
        }
        if (cur) { cur.mineConfirm = ''; if (cur.mine) loadMine(); else updateBody(); }
      })
      .catch(function (e) {
        toast((e && e.message) || 'the bundle delete failed');
        if (bcur && bcur.id === id && bunchTop()) {
          bcur.confirmDel = false;
          bunchRepaint();
          return;
        }
        if (cur) { cur.mineConfirm = ''; updateBody(); }
      });
  }

  // unmark a downloaded id across every repo variant (the local row's repo
  // is the right one, but a stale mark from another ref would linger) —
  // both the downloaded AND hearted maps.
  function unmarkDownloadedAll(type, id) {
    var suffix = '|' + id, prefix = type + '|';
    for (var key in downloaded) {
      if (key.indexOf(prefix) === 0 && key.slice(-suffix.length) === suffix) delete downloaded[key];
    }
    for (var hkey in hearted) {
      if (hkey.indexOf(prefix) === 0 && hkey.slice(-suffix.length) === suffix) delete hearted[hkey];
    }
  }

  // v0.60 pt B: wireCardHearts — the shared live-heart handler for BOTH the
  // library grid and the bunch view's member cards (same contract as the
  // old inline wireBody block).
  function wireCardHearts(host) {
    if (!host || !host.querySelectorAll) return;
    host.querySelectorAll('[data-heart]').forEach(function (h) {
      h.addEventListener('click', function (e) {
        e.stopPropagation();
        if (!cur) return;
        var card = h.closest('[data-item]');
        if (!card) return;
        var it = findItem(card.getAttribute('data-item'));
        if (!it) return;
        var type = it.type || cur.type;
        if (!isDownloaded(type, it.repo, it.id)) {
          // v0.58 (user spec pt 7): the footer pill says it out loud — then
          // the detail opens (that's where the download lives).
          toast('download first — endorsing needs a download', { ms: 2400 });
          if (window.HubItem) window.HubItem.open(type, it);
          return;
        }
        var on = !isHearted(type, it.repo, it.id);
        api('POST', '/api/hub/' + encodeURIComponent(type) +
            (on ? '/endorse' : '/unendorse'), { repo: it.repo, id: it.id })
          .then(function (d) {
            setHearted(type, it.repo, it.id, on);
            if (d && d.item) refreshItem(d.item);
            toast(on ? 'endorsed ♥' : 'endorsement removed');
            if (isTop()) updateBody();
            else if (bunchTop()) bunchRepaint();
          })
          .catch(function (e2) { toast((e2 && e2.message) || 'could not endorse'); });
      });
    });
  }

  function onClosed() {
    // v0.60 pt B: persist the browse state (final scroll included) BEFORE
    // cur goes away.
    saveHubstate();
    if (cur && cur._onResize) {
      window.removeEventListener('resize', cur._onResize);
      cur._onResize = null;
    }
    // v0.56: the scrunch scroll listener rides the panel body — remove it
    if (cur && cur._onHubScroll && cur.panel && cur.panel.bodyEl) {
      cur.panel.bodyEl.removeEventListener('scroll', cur._onHubScroll);
      cur._onHubScroll = null;
    }
    // v0.52: restore the header the hub neutralized (the panel's own
    // root-restore also re-puts the stashed values; this covers the
    // closeView-without-pop edge).
    try {
      var p = PV();
      if (p && p.avatarEl && cur && cur._hadHeader) {
        p.avatarEl.innerHTML = cur._savedAvatar || '';
        p.subEl.textContent = cur._savedSub || '';
      }
    } catch (e) {}
    // v0.60 pt B: CANVAS ENTRY — back/✕ on the library's main browsing page
    // closes the whole panel (the user returns to the CANVAS, not the
    // synthetic host chat opened just to hold the library). A chat connected
    // through the pill cleared fromCanvas, so that path pops normally.
    var fromCanvas = cur && cur.fromCanvas;
    var panel = cur ? cur.panel : null;
    cur = null;
    if (fromCanvas && panel) {
      try { panel.close(); } catch (e) {}
    }
  }

  // ── v0.52: the chat connection (user item 5) ────────────────────
  // The public library is DECOUPLED from chats: it opens with NO chat
  // connected (canvas entry) or with the launching chatbot's chat
  // already connected (pill entry points). The pill row at the top of
  // the view shows the connection; tapping it opens the merged
  // all-chats overlay in PICK mode (ChatsView.openPicker) — picking a
  // row updates the pill (and every library action that targets a
  // chat). chat: {sessionId, title, name, avatarHTML} | null.

  function deriveChatFromPanel() {
    var c = window.ChatPanel && window.ChatPanel.current();
    if (!c || !c.panel || !c.panel.isOpen || !c.panel.isOpen()) return null;
    if (!c.icon || c.icon.type !== 'chat') return null;
    var sid = (c.state && c.state.sessionId) || c.icon.sessionId || '';
    var title = (c.icon && c.icon.name) || '';
    var avatar = (c.icon && c.icon.getAvatarHTML) ? c.icon.getAvatarHTML() : '';
    if (!sid && !title) return null;
    return { sessionId: sid, title: title, name: title, avatarHTML: avatar };
  }

  function chatPillHTML() {
    var c = cur && cur.chat;
    var out = '';
    if (c && (c.sessionId || c.title)) {
      var label = esc(c.title || c.sessionId);
      if (c.name && c.name !== c.title) label += ' · ' + esc(c.name);
      out = '<button type="button" id="hub-chatpill" class="hub-chatpill" aria-label="connected chat: ' +
        escAttr(label) + ' — tap to change" title="tap to connect a different chat">' +
        '<span class="hub-chatpill-ico">' + (c.avatarHTML || '💬') + '</span>' +
        '<span class="hub-chatpill-label">' + label + '</span>' +
        '<span class="hub-chatpill-chev" aria-hidden="true">▾</span></button>';
    } else {
      out = '<button type="button" id="hub-chatpill" class="hub-chatpill hub-chatpill--none"' +
        ' aria-label="no chat connected — tap to connect one" title="tap to connect a chat">' +
        '<span class="hub-chatpill-ico">📚</span>' +
        '<span class="hub-chatpill-label">no chat</span>' +
        '<span class="hub-chatpill-chev" aria-hidden="true">▾</span></button>';
    }
    // v0.58 (user spec pt 8): MY-XYZ — the local-library FILTER pill. It
    // shows for EVERY browsed type ("my personas / my skills / my templates /
    // my themes"), relabels as the user browses, and FILTERS the grid to the
    // engine's downloaded items (no more redirect to the template sheet).
    if (cur) {
      out += '<button type="button" id="hub-locallib" class="hub-chatpill hub-chatpill--mine' +
        (cur.mine ? ' on' : '') + '"' +
        ' aria-pressed="' + (cur.mine ? 'true' : 'false') + '"' +
        ' title="show only your downloaded ' + esc(shortType(cur.type)) + 's"' +
        ' aria-label="' + escAttr(mineLabel(cur.type)) + ' — filter to your downloads">' +
        '<span class="hub-chatpill-ico">' + libIcon(cur.type) + '</span>' +
        '<span class="hub-chatpill-label">' + esc(mineLabel(cur.type)) + '</span>' +
        (cur.mine ? '<span class="hub-chatpill-chev" aria-hidden="true">✓</span>' : '') + '</button>';
    }
    return out;
  }

  function wireChatPill(root) {
    var pill = root.querySelector('#hub-chatpill');
    if (pill) pill.addEventListener('click', function () {
      if (!window.ChatsView || !window.ChatsView.openPicker) {
        toast('the all-chats view is not available');
        return;
      }
      window.ChatsView.openPicker(function (pick) {
        if (!cur) return;
        cur.chat = {
          sessionId: pick.session_id || '',
          title: pick.title || '',
          name: pick.title || '',
          avatarHTML: ''
        };
        // the icon avatar comes from the canvas icon when it exists
        try {
          var icon = (window.doomalay && window.doomalay.findIconForSession)
            ? window.doomalay.findIconForSession(cur.chat.sessionId) : null;
          if (icon && icon.getAvatarHTML) cur.chat.avatarHTML = icon.getAvatarHTML();
          if (icon && icon.name) cur.chat.name = icon.name;
        } catch (e) {}
        paintChatPill(root);
        toast('library connected to ' + (cur.chat.title || 'the chat'));
      });
    });
    // v0.58 (user spec pt 8): the my-xyz FILTER pill — taps toggle the
    // grid between the community and the user's downloads. (Guarded:
    // paintChatPill re-invokes this without replacing the my-pill node.)
    var local = root.querySelector('#hub-locallib');
    if (local && !local._mineWired) {
      local._mineWired = 1;
      local.addEventListener('click', function () {
        if (!cur) return;
        if (cur.mine) {
          cur.mine = false;
          cur.mineItems = null;
          cur.page = 1;
          saveHubstate(); // v0.60 pt B
          updateChatrow();
          updateBody();
          return;
        }
        cur.mine = true;
        cur.page = 1;
        saveHubstate(); // v0.60 pt B
        loadMine();
      });
    }
  }

  // v0.58: fetch the engine's downloads for the browsed type (the my-xyz
  // filter's source — it follows the user across devices + reinstalls).
  function loadMine() {
    if (!cur || !cur.type) return;
    var type = cur.type;
    cur.mineLoading = true;
    updateChatrow();
    updateBody();
    api('GET', '/api/hub/' + encodeURIComponent(type) + '/downloads')
      .then(function (d) {
        if (!cur || cur.type !== type || !cur.mine) return;
        cur.mineLoading = false;
        cur.mineItems = [];
        ((d && d.items) || []).forEach(function (r) {
          if (!r || !r.item) return;
          markDownloaded(type, r.item.repo, r.item.id);
          if (r.hearted) setHearted(type, r.item.repo, r.item.id, true);
          cur.mineItems.push(r.item);
        });
        updateBody();
      })
      .catch(function (e) {
        if (!cur || !cur.mine) return;
        cur.mineLoading = false;
        cur.mineItems = [];
        toast((e && e.message) || 'could not load your downloads');
        updateBody();
      });
  }

  function paintChatPill(root) {
    var old = root.querySelector('#hub-chatpill');
    if (!old) return;
    var tmp = document.createElement('div');
    tmp.innerHTML = chatPillHTML();
    var fresh = tmp.firstElementChild;
    if (fresh) old.parentNode.replaceChild(fresh, old);
    wireChatPill(root);
  }

  // ── entry ────────────────────────────────────────────────────────
  function open(type, opts) {
    var panel = PV();
    if (!panel) { toast('open a chat first'); return; }
    opts = opts || {};
    var chat = null;
    if (opts.chat) {
      chat = opts.chat; // explicit — {sessionId,title,name,avatarHTML} (or null-no-chat)
    } else if (opts.chat === undefined) {
      chat = deriveChatFromPanel(); // legacy callers: connect the hosting chat
    } // opts.chat === null → explicitly NO chat (the canvas entry)
    // v0.60 pt B: restore the last browse state. An explicit type argument
    // wins; q/tag/mine only restore when the browsed type matches the saved
    // one (a skills search makes no sense over templates).
    var saved = readHubstate() || {};
    var explicitType = !!type;
    var sameType = !explicitType || saved.type === type;
    cur = {
      panel: panel,
      chat: chat, // v0.52: null (no chat) | {sessionId,title,name,avatarHTML}
      // v0.60 pt B: opened from the CANVAS (app.js passes canvasHost when
      // it had to open a host panel just to hold the library) — back/✕ on
      // the main browsing page closes the whole panel (canvas), instead of
      // dropping the user on the synthetic host chat behind it.
      fromCanvas: !!opts.canvasHost,
      libraries: [],
      libErr: '',
      type: explicitType ? type : (saved.type || null),
      items: null,
      tags: [],
      q: sameType ? (saved.q || '') : '',
      sort: saved.sort || 'recent',
      tag: sameType ? (saved.tag || '') : '',
      page: 1,
      // v0.60 pt B: the saved page applies ONCE after the items land
      // (loadItems resets page=1 on fetch; bodyHTML clamps the overflow).
      _keepPage: sameType && saved.page > 1 ? saved.page : 0,
      _restoreScroll: sameType ? (saved.scroll || 0) : 0,
      grid: readGrid(),
      loading: false,
      stale: false,
      err: '',
      auth: null,
      width: 0,
      folded: !!saved.folded,
      eff: 0,
      collections: null,
      colSeq: 0,
      // v0.58: the my-xyz filter state
      mine: sameType && !!saved.mine,
      mineItems: null,
      mineLoading: false,
      _onResize: null
    };
    panel.pushView(buildView());
    // safety net: the chat root's async label repaint can still race a
    // freshly pushed view (it would write bodyEl directly) — one delayed
    // self-heal repaints the hub if its DOM vanished. The race itself
    // is fixed in chatpanel.js (the repaint defers while views are
    // stacked); this is the belt under the suspenders.
    setTimeout(function () {
      if (cur && cur.panel && isTop() && !q('#hub-topdock')) {
        cur.panel.replaceView(buildView());
      }
    }, 650);
    fetchLibraries();
  }

  // ── cross-module state (hubitem / hubpublish call these) ─────────
  function markDownloaded(type, repo, id) { downloaded[stateKey(type, repo, id)] = true; }
  function isDownloaded(type, repo, id) { return !!downloaded[stateKey(type, repo, id)]; }
  // v0.60 pt A.3: delete-your-copy clears the local mark (hubitem doDelete).
  function unmarkDownloaded(type, repo, id) { delete downloaded[stateKey(type, repo, id)]; }
  function setHearted(type, repo, id, on) {
    if (on) hearted[stateKey(type, repo, id)] = true;
    else delete hearted[stateKey(type, repo, id)];
  }
  function isHearted(type, repo, id) { return !!hearted[stateKey(type, repo, id)]; }

  // force the next render of {type}'s list to refetch (after publish) +
  // re-read the auth state (the connect flow may have just changed it).
  function markStale(type) {
    if (cur && (!type || cur.type === type)) {
      cur.stale = true; cur.auth = null;
      if (isTop()) { loadItems(true); loadAuth(); }
    }
  }

  // update the in-place copy so back-navigation shows fresh counters
  function refreshItem(item) {
    if (!cur || !cur.items || !item) return;
    for (var i = 0; i < cur.items.length; i++) {
      if (cur.items[i].id === item.id) { cur.items[i] = item; break; }
    }
  }

  window.Hub = {
    open: open,
    // v0.52: the connected chat (null when the library is unbound) —
    // the chat toolbar's [template|+] / [skills|+] buttons and any
    // "apply to this chat" action read this.
    chat: function () { return cur ? cur.chat : null; },
    // v0.60 pt B: connecting a chat through the pill clears the canvas
    // entry — back from the library then pops to the chat panel normally
    // (the library is no longer canvas-rooted).
    setChat: function (chat) {
      if (!cur) return;
      cur.chat = chat || null;
      if (chat) cur.fromCanvas = false;
    },
    markStale: markStale,
    refreshItem: refreshItem,
    isDownloaded: isDownloaded,
    markDownloaded: markDownloaded,
    unmarkDownloaded: unmarkDownloaded,
    setHearted: setHearted,
    isHearted: isHearted,
    toast: toast,
    idGradient: idGradient,
    // v0.67.5: the bundle-download registry (read + trigger) — tests and
    // the chat-side tooling can observe/arm the persistent state.
    bundleDL: function (id) { return id ? bdlEntry(id) : bdlLoad(); },
    bundleDownload: runBundleDownload
  };
})();
