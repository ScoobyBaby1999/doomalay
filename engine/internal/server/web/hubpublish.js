// hubpublish.js — v0.31→v0.44 THE HUB: publish + the Hugging Face connect flow.
//
// USER SPEC (Batch 10): "The publish page should be scrollable or act
// more like the editor pages… the user should be able to scroll or
// collapse all the previous options and have most of the screen display
// the contents of the file itself… Please make the * next to the Name
// box a primary color, and also make sure to use the updated gradient
// from before when setting the background, this applies to the random
// as well, which should use a random gradient and not strictly 2 or 3
// colors."
//
// v0.44: the card design rides the full gradient SPEC (the shared
// GradientUI v2 system — "tweaking the per chat gradients… use the
// gradient system"): style / pattern / angle rows + an optional
// texture (a dataURL ≤ the engine's 200KB design cap, sent inline in
// the design — the hub card bakes it into the css, unlike the chat bg
// which uploads to a rev'd engine row). The preview strip renders the
// exact css the card will.
//
// So the form is three COLLAPSIBLE sections (the essentials · card
// design · payload) with the payload carrying a FOCUS toggle — ⤢ grows
// it to own the whole panel (the other sections collapse away and come
// back with one tap), exactly like the editor pages treat their body.
// The image picker rides CropUI — drag the image under the card's
// frame; the crop is taken from the ORIGINAL pixels, so resolution and
// clarity are kept (≤1024px long edge, never stretched).
//
// If the engine answers 401 (no HF token), the FORM IS NOT LOST: a
// CONNECT view stacks on top — step 1 opens the HF token page
// (https://huggingface.co/settings/tokens/new?scopes=repo.write — on
// Android shouldOverrideUrlLoading hands it to Chrome), step 2 pastes
// the token into POST /api/hub/auth/connect (verified engine-side via
// whoami; a bad token shows inline and stays). On success the pending
// publish auto-resumes; on publish OK the new item's detail opens.
//
// v0.44 TEMPLATE PILL: templates publish through the SAME flow (type
// "template"; payload = the template JSON — the sheet prefills
// name/desc/payload from the library entry via open()'s prefill).
//
// Exposes: window.HubPublish = { open }
(function () {
  'use strict';

  var MAX_TAGS = 15, MAX_TAG_LEN = 24; // the engine's caps — mirrored UI-side

  var cur = null; // { panel, type, name, desc, tags, design:{kind,spec}, pngBase64, payload, folds, focus }

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

  // ── entry ────────────────────────────────────────────────────────
  // v0.44: prefill now also carries desc — the template sheet publishes
  // an existing library entry with its description already filled.
  function open(type, prefill) {
    var panel = PV();
    if (!panel) { toast('open a chat first'); return; }
    prefill = prefill || {};
    var GU = window.GradientUI || { random: function () { return ['#38bdf8', '#a78bfa']; } };
    cur = {
      panel: panel,
      type: type || 'persona',
      name: prefill.name || '',
      desc: prefill.desc || '',
      tags: [],
      // v0.44: a full gradient spec — "none" still sends the picked
      // gradient (the card stays deterministic)
      design: { kind: 'none', spec: { colors: GU.random(), dir: 'auto' } },
      pngBase64: '',
      payload: prefill.payload || '',
      folds: { details: false, design: false },       // sections start open
      focus: false                                    // payload focus mode
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
      return (window.UIPills ? window.UIPills.chip('#' + t, { rm: 'data-untag="' + i + '"' })
        : '<span class="dx-chip">#' + esc(t) +
          '<button data-untag="' + i + '" title="remove" aria-label="remove tag">✕</button></span>');
    }).join('');

    var desg = c.design.kind;
    var designHTML = '';
    if (desg === 'gradient') {
      designHTML =
        '<div class="hp-design">' +
          (window.GradientUI ? window.GradientUI.editor('hp', c.design.spec) : '') +
        '</div>';
    } else if (desg === 'image') {
      designHTML =
        '<div class="hp-design">' +
          '<div class="hp-imgrow">' +
            '<button class="hp-pick" id="hp-pick">🖼 choose an image</button>' +
            '<input type="file" id="hp-file" accept="image/*" style="display:none">' +
          '</div>' +
          (c.pngBase64 ? '<div class="hp-imgmeta">image ready — cropped from the original at full clarity' +
            ' <button class="hp-mini" id="hp-rm-img">✕ remove</button></div>' : '') +
        '</div>';
    } else {
      designHTML =
        '<div class="hp-design">' +
          '<p class="pv-hint" style="margin:0">a random gradient is generated for the card —' +
            ' any number of colors, not just two or three.' +
            ' <button class="hp-mini" id="hp-reroll">↻ regenerate</button> or pick your own.</p>' +
        '</div>';
    }

    var previewBg = previewBackground();

    // the essentials + card design collapse; the payload has the FOCUS
    // toggle that grows it to own the panel (the editor-page behavior)
    return (
      '<div class="hp-root' + (c.focus ? ' hp-focus' : '') + '" id="hp-root">' +
        '<p class="pv-hint">share with the community — this publishes to <b>your own Hugging Face dataset</b> (' +
          esc(c.type) + ' library). The engine creates the repo, uploads the item and updates the index.</p>' +

        '<div class="hp-sec' + (c.folds.details ? ' folded' : '') + '" id="hp-sec-details">' +
          '<div class="hp-sec-bar" data-fold="details" role="button" tabindex="0">' +
            '<span class="hp-sec-title">the essentials</span>' +
            '<span class="hp-sec-chev">' + (c.folds.details ? '▸' : '▾') + '</span>' +
          '</div>' +
          '<div class="hp-sec-body">' +
            '<div class="pv-section-label">name <span class="hp-star">*</span></div>' +
            '<input id="hp-name" class="pv-input" placeholder="the visible name" value="' + escAttr(c.name) + '">' +
            '<div class="pv-section-label">description</div>' +
            '<textarea id="hp-desc" class="hp-textarea" rows="2" placeholder="what is it for? (optional)">' + esc(c.desc) + '</textarea>' +
            '<div class="pv-section-label">tags</div>' +
            (chips ? '<div class="hp-chips">' + chips + '</div>' : '') +
            '<input id="hp-tag-in" class="pv-input" placeholder="type a tag + enter (max ' + MAX_TAGS + ' × ' + MAX_TAG_LEN + ' chars)">' +
          '</div>' +
        '</div>' +

        '<div class="hp-sec' + (c.folds.design ? ' folded' : '') + '" id="hp-sec-design">' +
          '<div class="hp-sec-bar" data-fold="design" role="button" tabindex="0">' +
            '<span class="hp-sec-title">card design</span>' +
            '<span class="hp-sec-chev">' + (c.folds.design ? '▸' : '▾') + '</span>' +
          '</div>' +
          '<div class="hp-sec-body">' +
            '<div class="hp-seg">' +
              '<button data-desg="none"' + (desg === 'none' ? ' data-on="1"' : '') + '>random</button>' +
              '<button data-desg="gradient"' + (desg === 'gradient' ? ' data-on="1"' : '') + '>gradient</button>' +
              '<button data-desg="image"' + (desg === 'image' ? ' data-on="1"' : '') + '>image</button>' +
            '</div>' +
            designHTML +
            '<div class="hp-preview" id="hp-preview" style="' + previewBg + '"></div>' +
          '</div>' +
        '</div>' +

        '<div class="hp-sec hp-payload-sec" id="hp-sec-payload">' +
          '<div class="hp-sec-bar">' +
            '<span class="hp-sec-title">payload' + (c.type === 'persona' ? ' (.md)' : ' (.json)') +
              ' <span class="hp-star">*</span></span>' +
            '<button type="button" class="hp-focus-btn" id="hp-focus" title="grow the payload to own the screen">' +
              (c.focus ? '⤡ collapse' : '⤢ focus') + '</button>' +
          '</div>' +
          '<div class="hp-sec-body">' +
            '<textarea id="hp-payload" class="hp-textarea hp-payload" placeholder="' +
              (c.type === 'persona' ? 'the persona markdown — the text the model receives' : 'the template JSON') + '">' +
              esc(c.payload) + '</textarea>' +
          '</div>' +
        '</div>' +

        '<button id="hp-publish" class="pv-btn pv-btn-primary" style="width:100%">⤴ publish to the hub</button>' +
        '<div class="hp-err" id="hp-err"></div>' +
      '</div>'
    );
  }

  // the preview strip — the exact css the published card will render
  // (tex dataURL inline, gradient over it with blend 'color' per the
  // uikit contract); 1-color plain → background-color (the solid case)
  function previewBackground() {
    var c = cur;
    if (c.design.kind === 'image' && c.pngBase64) {
      return 'background-image:url(data:image/png;base64,' + c.pngBase64 + ')';
    }
    var GU = window.GradientUI;
    var spec = (c.design.spec && c.design.spec.colors && c.design.spec.colors.length)
      ? c.design.spec : null;
    if (GU && spec) {
      var css = GU.css(spec);
      if (css.charAt(0) === '#') return 'background-color:' + css;
      return 'background-image:' + css +
        ((spec.tex && GU.BLENDED) ? ';background-blend-mode:color' : '');
    }
    var colors = (spec && spec.colors.length) ? spec.colors : ['#38bdf8', '#a78bfa'];
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

    // collapsible sections — a class toggle + chev swap, no re-render
    el.querySelectorAll('[data-fold]').forEach(function (bar) {
      var toggle = function () {
        var key = bar.getAttribute('data-fold');
        c.folds[key] = !c.folds[key];
        var sec = bar.closest('.hp-sec');
        if (sec) {
          sec.classList.toggle('folded', c.folds[key]);
          var chev = sec.querySelector('.hp-sec-chev');
          if (chev) chev.textContent = c.folds[key] ? '▸' : '▾';
        }
      };
      bar.addEventListener('click', toggle);
      bar.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
      });
    });

    // the payload FOCUS toggle — the payload owns the screen and back
    var focus = el.querySelector('#hp-focus');
    if (focus) focus.addEventListener('click', function (e) {
      e.stopPropagation();
      c.focus = !c.focus;
      var root = el.querySelector('#hp-root');
      if (root) root.classList.toggle('hp-focus', c.focus);
      focus.textContent = c.focus ? '⤡ collapse' : '⤢ focus';
      if (!c.focus && payload && c.payload) {
        // returning from focus — re-center the scroll on the payload
        try { payload.scrollIntoView({ block: 'nearest' }); } catch (err) {}
      }
    });

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

    // the design segment — switching to gradient KEEPS an existing spec
    // (back-and-forth no longer re-randomizes the user's edit); a fresh
    // publish starts from the familiar pair
    el.querySelectorAll('[data-desg]').forEach(function (b) {
      b.addEventListener('click', function () {
        var k = b.getAttribute('data-desg');
        if (k === c.design.kind) return;
        if (k === 'gradient' && !(c.design.spec && c.design.spec.colors && c.design.spec.colors.length)) {
          c.design.spec = { colors: (window.GradientUI || { random: function () { return ['#38bdf8', '#a78bfa']; } }).random(2), dir: 'auto' };
        }
        if (k !== 'image') c.pngBase64 = '';
        c.design.kind = k;
        c.panel.replaceView(buildView());
      });
    });

    // the shared gradient editor — FULL options (style / pattern /
    // angle / texture); wire() mutates the live spec IN PLACE, live
    // (color / angle) repaints the preview strip in place, shape changes
    // re-render (the form's values live in `cur`, so nothing is lost)
    if (window.GradientUI) {
      var gr = el.querySelector('#hp-gr');
      if (gr && c.design.spec) window.GradientUI.wire(gr, {
        spec: c.design.spec,
        live: function () {
          var pv = el.querySelector('#hp-preview');
          if (pv) pv.setAttribute('style', previewBackground());
        },
        rebuild: function () { c.panel.replaceView(buildView()); }
      });
    }

    // random — a NEW random gradient (any count, not just 2–3; colors
    // only — a chosen style/texture survives the reroll, the uikit ↻
    // contract)
    var reroll = el.querySelector('#hp-reroll');
    if (reroll) reroll.addEventListener('click', function () {
      var rnd = (window.GradientUI || { random: function () { return ['#38bdf8', '#a78bfa']; } }).random();
      var spec = c.design.spec || (c.design.spec = {});
      spec.colors = rnd;
      if (!spec.dir) spec.dir = 'auto';
      c.panel.replaceView(buildView());
    });

    // the image picker — CropUI (drag to crop, original-pixel output)
    var pick = el.querySelector('#hp-pick');
    var file = el.querySelector('#hp-file');
    if (pick && file) {
      pick.addEventListener('click', function () { file.click(); });
      file.addEventListener('change', function () {
        var f = file.files && file.files[0];
        if (!f) return;
        if (!window.CropUI) {
          toast('the cropper is not available');
          return;
        }
        pick.textContent = 'opening the cropper…';
        window.CropUI.open({
          file: f,
          aspect: 1.5,       // the card/detail header's landscape frame
          maxEdge: 1024,      // clarity kept — never stretched to fit
          onDone: function (b64, meta) {
            c.pngBase64 = b64;
            c.panel.replaceView(buildView());
            toast('cropped ' + meta.width + '×' + meta.height + ' at full clarity');
          },
          onErr: function (msg) {
            toast(msg || 'could not read that image');
            pick.textContent = '🖼 choose an image';
          }
        });
        pick.textContent = '🖼 choose an image';
        file.value = '';      // allow re-picking the same file
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

  // what the engine receives: "none" sends the generated gradient (the
  // card stays deterministic); "image" rides the pngBase64 field; the
  // gradient carries the FULL v0.44 spec — colors + dir + angle + the
  // tex dataURL (≤ the engine's 200KB design cap; empty when none).
  function designOut() {
    if (cur.design.kind === 'image') return { kind: 'png', colors: [] };
    var GU = window.GradientUI;
    if (!GU || !cur.design.spec || !cur.design.spec.colors || !cur.design.spec.colors.length) {
      // no editor (or an empty spec) — the deterministic random pair
      var fallback = (GU || { random: function () { return ['#38bdf8', '#a78bfa']; } }).random();
      return { kind: 'gradient', colors: fallback, dir: 'auto' };
    }
    var n = GU.norm(cur.design.spec);
    var out = { kind: 'gradient', colors: n.colors, dir: n.dir };
    if (typeof n.angle === 'number') out.angle = n.angle;
    if (n.tex) out.tex = n.tex;   // the dataURL rides the item JSON
    return out;
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
  // v0.48 (task 3): the hand-written two-step token instructions are GONE.
  // This view is now THE shared connect panel (hfconnect.js) — the same one
  // the sandbox picker's "Connect to HF" button opens: one-tap OAuth
  // (auto-acquired token), an optional manual paste box, and a get-token
  // link. Success -> popView + the pending publish auto-resumes.
  function openConnect() {
    if (!cur) return;
    var panel = cur.panel;
    panel.pushView(window.HFConnect.connectPanelView({
      onDone: function () {
        toast('connected to Hugging Face');
        if (window.Hub && window.Hub.markStale) window.Hub.markStale(); // status line refresh
        panel.popView();   // back onto the intact form...
        doPublish();       // ...and the pending publish auto-resumes
      }
    }));
  }

  window.HubPublish = { open: open };
})();
