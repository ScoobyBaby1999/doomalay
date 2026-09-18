// hubpublish.js — v0.31 THE HUB: publish + the Hugging Face connect flow.
//
// USER SPEC: the user only ever logs into HF — the app does everything
// else in the background and the user never leaves the app. Publish
// settings: name (REQUIRED), description, tags (≤15 × 24 chars,
// sanitized), and the card design — a gradient of 2–3 picked colors, an
// uploaded PNG (canvas-downscaled ≤512px client-side, the tweaks.js
// pipeline pattern), or "none" (= the app picks a random pair NOW and
// sends it, so the card is still deterministic).
//
// If the engine answers 401 (no HF token), the FORM IS NOT LOST: a
// CONNECT view stacks on top — step 1 opens the HF token page
// (https://huggingface.co/settings/tokens/new?scopes=repo.write — on
// Android shouldOverrideUrlLoading hands it to Chrome), step 2 pastes
// the token into POST /api/hub/auth/connect (verified engine-side via
// whoami; a bad token shows inline and stays). On success the pending
// publish auto-resumes; on publish OK the new item's detail opens.
//
// Entry points: the hub panel's "＋ publish" button (standalone — the
// payload textarea starts EMPTY and is required), and the persona
// editor's publish pill (prefills name + payload from the persona).
//
// Exposes: window.HubPublish = { open }
(function () {
  'use strict';

  var MAX_TAGS = 15, MAX_TAG_LEN = 24; // the engine's caps — mirrored UI-side

  var cur = null; // { panel, type, name, desc, tags, design, pngBase64, payload }

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
  function view(title, renderHTML, wire) {
    return {
      title: title,
      render: function () { return renderHTML(); },
      onMount: function (el) { if (wire) wire(el); }
    };
  }

  var toastTimer = null;
  function toast(msg) {
    if (window.Hub && window.Hub.toast) { window.Hub.toast(msg); return; }
    var t = document.getElementById('hubpub-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'hubpub-toast';
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

  // ── colors ────────────────────────────────────────────────────────
  function hslToHex(h, s, l) {
    s /= 100; l /= 100;
    var k = function (n) { return (n + h / 30) % 12; };
    var a = s * Math.min(l, 1 - l);
    var f = function (n) {
      var v = l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
      return Math.round(255 * v).toString(16).padStart(2, '0');
    };
    return '#' + f(0) + f(8) + f(4);
  }
  // 2 hues in the readable S/L bands (60–80% / 45–65%) — the same recipe
  // hub.js's deterministic id-gradient uses.
  function randomPair() {
    var h1 = Math.floor(Math.random() * 360);
    var h2 = (h1 + 40 + Math.floor(Math.random() * 80)) % 360;
    var s1 = 60 + Math.floor(Math.random() * 21);
    var l1 = 45 + Math.floor(Math.random() * 21);
    return [hslToHex(h1, s1, l1), hslToHex(h2, s1, Math.min(65, l1 + 8))];
  }

  // mirror the engine's SanitizeTags (client-side prevalidation)
  function sanitizeTag(raw) {
    var t = String(raw || '').toLowerCase()
      .replace(/[^a-z0-9- ]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_TAG_LEN)
      .trim();
    return t;
  }

  // ── the PNG pipeline (canvas downscale ≤512px, PNG re-encode) ────
  function pngFromFile(file, maxEdge) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        try {
          var w = img.naturalWidth, h = img.naturalHeight;
          var scale = Math.min(1, maxEdge / Math.max(w, h));
          var cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
          var cv = document.createElement('canvas');
          cv.width = cw; cv.height = ch;
          cv.getContext('2d').drawImage(img, 0, 0, cw, ch);
          URL.revokeObjectURL(url);
          var dataURL = cv.toDataURL('image/png');
          if (!dataURL || dataURL.indexOf('base64,') < 0) throw new Error('encode failed');
          resolve(dataURL);
        } catch (e) { URL.revokeObjectURL(url); reject(e); }
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('not readable')); };
      img.src = url;
    });
  }

  // ── entry ────────────────────────────────────────────────────────
  function open(type, prefill) {
    var panel = PV();
    if (!panel) { toast('open a chat first'); return; }
    prefill = prefill || {};
    cur = {
      panel: panel,
      type: type || 'persona',
      name: prefill.name || '',
      desc: '',
      tags: [],
      design: { kind: 'none', colors: randomPair() }, // "none" still sends a picked pair
      pngBase64: '',
      payload: prefill.payload || ''
    };
    panel.pushView(buildView());
  }

  function buildView() {
    return view('publish · ' + cur.type, function () { return renderHTML(); },
      function (el) { wire(el); });
  }

  // ── rendering ─────────────────────────────────────────────────────
  function renderHTML() {
    if (!cur) return '';
    var c = cur;

    var chips = c.tags.map(function (t, i) {
      return '<span class="hp-chip">#' + esc(t) +
        '<button data-untag="' + i + '" title="remove" aria-label="remove tag">✕</button></span>';
    }).join('');

    var desg = c.design.kind;
    var designHTML = '';
    if (desg === 'gradient') {
      var cols = '';
      for (var i = 0; i < c.design.colors.length && i < 3; i++) {
        cols += '<input type="color" class="hp-color" data-color="' + i + '" value="' +
          escAttr(c.design.colors[i]) + '" aria-label="gradient color ' + (i + 1) + '">';
      }
      designHTML =
        '<div class="hp-colors">' + cols +
          (c.design.colors.length < 3 ? '<button class="hp-mini" id="hp-add-color" title="add a third color">＋</button>' : '') +
          '<button class="hp-mini" id="hp-shuffle" title="shuffle the colors">⤨ shuffle</button>' +
        '</div>';
    } else if (desg === 'image') {
      designHTML =
        '<div class="hp-imgrow">' +
          '<button class="hp-pick" id="hp-pick">🖼 choose an image</button>' +
          '<input type="file" id="hp-file" accept="image/*" style="display:none">' +
        '</div>' +
        (c.pngBase64 ? '<div class="hp-imgmeta">image ready — downscaled to ≤512px PNG' +
          ' <button class="hp-mini" id="hp-rm-img">✕ remove</button></div>' : '');
    } else {
      designHTML =
        '<p class="pv-hint" style="margin:0">a random gradient pair is generated for the card' +
        ' — <button class="hp-mini" id="hp-reroll">↻ regenerate</button> or pick your own.</p>';
    }

    var previewBg = previewBackground();

    return (
      '<div class="hp-root">' +
        '<p class="pv-hint">share with the community — this publishes to <b>your own Hugging Face dataset</b> (' +
          esc(c.type) + ' library). The engine creates the repo, uploads the item and updates the index.</p>' +
        '<div class="pv-section-label">name *</div>' +
        '<input id="hp-name" class="pv-input" placeholder="the visible name" value="' + escAttr(c.name) + '">' +
        '<div class="pv-section-label">description</div>' +
        '<textarea id="hp-desc" class="hp-textarea" rows="2" placeholder="what is it for? (optional)">' + esc(c.desc) + '</textarea>' +
        '<div class="pv-section-label">tags</div>' +
        (chips ? '<div class="hp-chips">' + chips + '</div>' : '') +
        '<input id="hp-tag-in" class="pv-input" placeholder="type a tag + enter (max ' + MAX_TAGS + ' × ' + MAX_TAG_LEN + ' chars)">' +
        '<div class="pv-section-label">card design</div>' +
        '<div class="hp-seg">' +
          '<button data-desg="none"' + (desg === 'none' ? ' data-on="1"' : '') + '>random</button>' +
          '<button data-desg="gradient"' + (desg === 'gradient' ? ' data-on="1"' : '') + '>gradient</button>' +
          '<button data-desg="image"' + (desg === 'image' ? ' data-on="1"' : '') + '>image</button>' +
        '</div>' +
        '<div class="hp-design">' + designHTML + '</div>' +
        '<div class="hp-preview" id="hp-preview" style="' + previewBg + '"></div>' +
        '<div class="pv-section-label">payload' + (c.type === 'persona' ? ' (.md)' : ' (.json)') + ' *</div>' +
        '<textarea id="hp-payload" class="hp-textarea hp-payload" placeholder="' +
          (c.type === 'persona' ? 'the persona markdown — the text the model receives' : 'the template JSON') + '">' +
          esc(c.payload) + '</textarea>' +
        '<button id="hp-publish" class="pv-btn pv-btn-primary" style="width:100%">⤴ publish to the hub</button>' +
        '<div class="hp-err" id="hp-err"></div>' +
      '</div>'
    );
  }

  function previewBackground() {
    var c = cur;
    if (c.design.kind === 'image' && c.pngBase64) {
      return 'background-image:url(data:image/png;base64,' + c.pngBase64 + ')';
    }
    var colors = (c.design.colors && c.design.colors.length >= 2)
      ? c.design.colors : ['#38bdf8', '#a78bfa'];
    return 'background-image:linear-gradient(135deg,' + colors.join(',') + ')';
  }

  // ── wiring ────────────────────────────────────────────────────────
  function wire(el) {
    if (!cur) return;
    var c = cur;

    // live state harvest (the view re-renders on segment switches — the
    // form's values survive in `cur`)
    var name = el.querySelector('#hp-name');
    if (name) name.addEventListener('input', function () { c.name = name.value; });
    var desc = el.querySelector('#hp-desc');
    if (desc) desc.addEventListener('input', function () { c.desc = desc.value; });
    var payload = el.querySelector('#hp-payload');
    if (payload) payload.addEventListener('input', function () { c.payload = payload.value; });

    // tags — Enter adds a chip (sanitized, capped, deduped)
    var tagIn = el.querySelector('#hp-tag-in');
    if (tagIn) tagIn.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      addTag(tagIn.value);
      tagIn.value = '';
    });
    el.querySelectorAll('[data-untag]').forEach(function (b) {
      b.addEventListener('click', function () {
        c.tags.splice(parseInt(b.getAttribute('data-untag'), 10) || 0, 1);
        c.panel.replaceView(buildView());
      });
    });

    // the design segment
    el.querySelectorAll('[data-desg]').forEach(function (b) {
      b.addEventListener('click', function () {
        var k = b.getAttribute('data-desg');
        if (k === c.design.kind) return;
        if (k === 'gradient' && c.design.colors.length < 2) c.design.colors = randomPair();
        if (k !== 'image') c.pngBase64 = '';
        c.design.kind = k;
        c.panel.replaceView(buildView());
      });
    });

    // gradient pickers / shuffle / third color
    el.querySelectorAll('[data-color]').forEach(function (inp) {
      inp.addEventListener('input', function () {
        c.design.colors[parseInt(inp.getAttribute('data-color'), 10) || 0] = inp.value;
        var pv = el.querySelector('#hp-preview');
        if (pv) pv.setAttribute('style', previewBackground());
      });
    });
    var shuffle = el.querySelector('#hp-shuffle');
    if (shuffle) shuffle.addEventListener('click', function () {
      c.design.colors = randomPair();
      c.panel.replaceView(buildView());
    });
    var addColor = el.querySelector('#hp-add-color');
    if (addColor) addColor.addEventListener('click', function () {
      var pair = randomPair();
      c.design.colors.push(pair[0]);
      c.panel.replaceView(buildView());
    });
    var reroll = el.querySelector('#hp-reroll');
    if (reroll) reroll.addEventListener('click', function () {
      c.design.colors = randomPair();
      c.panel.replaceView(buildView());
    });

    // the image picker — canvas downscale ≤512px → PNG base64
    var pick = el.querySelector('#hp-pick');
    var file = el.querySelector('#hp-file');
    if (pick && file) {
      pick.addEventListener('click', function () { file.click(); });
      file.addEventListener('change', function () {
        var f = file.files && file.files[0];
        if (!f) return;
        pick.textContent = 'downscaling…';
        pngFromFile(f, 512).then(function (dataURL) {
          c.pngBase64 = dataURL.slice(dataURL.indexOf('base64,') + 7);
          c.panel.replaceView(buildView());
        }).catch(function (e) {
          toast(e.message || 'could not read that image');
          pick.textContent = '🖼 choose an image';
        });
      });
    }
    var rmImg = el.querySelector('#hp-rm-img');
    if (rmImg) rmImg.addEventListener('click', function () {
      c.pngBase64 = '';
      c.panel.replaceView(buildView());
    });

    // PUBLISH
    var pub = el.querySelector('#hp-publish');
    if (pub) pub.addEventListener('click', function () { doPublish(); });
  }

  function addTag(raw) {
    var t = sanitizeTag(raw);
    if (!t) return;
    if (cur.tags.indexOf(t) >= 0) return; // dup — quiet
    if (cur.tags.length >= MAX_TAGS) { toast(MAX_TAGS + ' tags max'); return; }
    cur.tags.push(t);
    cur.panel.replaceView(buildView());
  }

  // what the engine receives: "none" sends the generated pair (the card
  // stays deterministic); "image" rides the pngBase64 field.
  function designOut() {
    if (cur.design.kind === 'image') return { kind: 'png', colors: [] };
    var colors = (cur.design.colors && cur.design.colors.length >= 2)
      ? cur.design.colors.slice(0, 3) : randomPair();
    return { kind: 'gradient', colors: colors };
  }

  // ── publish ───────────────────────────────────────────────────────
  function doPublish() {
    if (!cur) return;
    var errEl = cur.panel.bodyEl.querySelector('#hp-err');
    var btn = cur.panel.bodyEl.querySelector('#hp-publish');
    if (errEl) errEl.textContent = '';
    if (btn) { btn.disabled = true; btn.textContent = 'publishing…'; }
    api('POST', '/api/hub/' + encodeURIComponent(cur.type) + '/publish', {
      name: cur.name,
      description: cur.desc,
      tags: cur.tags,
      design: designOut(),
      payload: cur.payload,
      pngBase64: cur.pngBase64 || ''
    }).then(function (d) {
      var item = d.item, repo = d.repo;
      toast('published to ' + repo);
      if (window.Hub) {
        window.Hub.markDownloaded(cur.type, item.repo, item.id);
        window.Hub.markStale(cur.type);
      }
      var payload = cur.payload, type = cur.type;
      cur = null;                       // this view is about to be popped
      var panel = PV();
      panel.popView();                  // drop the publish form…
      window.HubItem.open(type, item, { payload: payload }); // …straight into the detail
    }).catch(function (e) {
      if (btn) { btn.disabled = false; btn.textContent = '⤴ publish to the hub'; }
      if (e.status === 401) {
        openConnect();                  // the form survives underneath
        return;
      }
      if (errEl) errEl.textContent = e.message || 'the publish failed';
      else toast(e.message || 'the publish failed');
    });
  }

  // ── the HF connect flow (stacked OVER the intact publish form) ─────
  // v0.31.2 (user spec): the step headers are BRIGHTER (accent via the
  // formatter's own --fmt-bright / --fmt-link slots) and the step
  // subtexts are LARGER, in a primary theme color, with DETAILED
  // instructions that mirror the real HF token page (pick WRITE — not
  // Fine-grained/CI-CD/Full Access; the link pre-selects Write). Flow
  // logic is unchanged: 401 → inline error, success → auto-resume.
  function openConnect() {
    if (!cur) return;
    var panel = cur.panel;
    panel.pushView(view('connect hugging face', function () {
      return (
        '<div class="hp-root">' +
        '<p class="pv-hint">Publishing runs through <b>your own Hugging Face account</b> — a free token with the <b>repo.write</b> scope is all it takes. The engine keeps it in its secrets vault; this page never sees it.</p>' +
        '<div class="hc-step"><span class="hc-num">step 1</span>Open Hugging Face and create a token</div>' +
        '<p class="hc-sub">After logging in, scroll down to the ‘New token’ section. Under ‘Create new Access Token’, pick a name (e.g. doomalay), then select a Token type: choose WRITE. Write tokens let Doomalay push to the Hub: it can create your library datasets, read repository contents, and upload your published items. You do NOT need Fine-grained, CI/CD, or Full Access. (The link below opens the page with Write already selected.)</p>' +
        '<button id="hc-open" class="pv-btn" style="width:100%">Open Hugging Face ↗</button>' +
        '<div class="hc-step"><span class="hc-num">step 2</span>Paste your new token here</div>' +
        '<p class="hc-sub">On the Hugging Face page, click ‘Create token’ and copy the token it shows you (it starts with hf_ and is shown only once). Paste it below — Doomalay verifies it and remembers it in your device’s secret vault. You never leave the app.</p>' +
        '<input id="hc-token" class="pv-input" type="text" placeholder="hf_…" autocomplete="off">' +
        '<button id="hc-connect" class="pv-btn pv-btn-primary" style="width:100%;margin-top:8px">connect</button>' +
        '<div class="hp-err" id="hc-err"></div>' +
        '</div>'
      );
    }, function (el) {
      el.querySelector('#hc-open').addEventListener('click', function () {
        // Android: shouldOverrideUrlLoading hands this to Chrome
        window.open('https://huggingface.co/settings/tokens/new?scopes=repo.write', '_blank');
      });
      el.querySelector('#hc-connect').addEventListener('click', function () {
        var errEl = el.querySelector('#hc-err');
        var tok = (el.querySelector('#hc-token').value || '').trim();
        if (!tok) { errEl.textContent = 'paste the token first'; return; }
        errEl.textContent = '';
        var btn = el.querySelector('#hc-connect');
        btn.disabled = true; btn.textContent = 'connecting…';
        api('POST', '/api/hub/auth/connect', { token: tok })
          .then(function (d) {
            toast('connected as ' + (d.username || '?'));
            btn.disabled = false; btn.textContent = 'connect';
            if (window.Hub && window.Hub.markStale) window.Hub.markStale(); // status line refresh
            panel.popView();   // back onto the intact form…
            doPublish();       // …and the pending publish auto-resumes
          })
          .catch(function (e) {
            btn.disabled = false; btn.textContent = 'connect';
            errEl.textContent = e.message || 'Hugging Face rejected the token';
          });
      });
    }));
  }

  window.HubPublish = { open: open };
})();
