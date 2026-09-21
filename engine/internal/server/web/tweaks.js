// tweaks.js — v0.30 THE PER-CHAT SETTINGS (the ✦ tweaks pill).
//
// USER SPEC: "Let's add a tweaks pill next to the usage and export chat
// pills in the chat metadata header. The tweaks pill should open a panel
// that acts as a per chat settings panel. Here, we try and show the same
// UI that we show in the settings in terms of allowing the customisation
// of the chat colors, and text size… The per chat settings should override
// the global settings… Add another section that allows the user to change
// the background of the panel to an image of their choosing from their
// library, or a background color of their choice."
//
// THE NO-DUPLICATION ANSWER: the tweaks view renders the EXACT markup the
// settings pages render — the same AppearanceUI builders (appearance.js
// exports its swatch grid / fmt color rows / size sliders), the same
// generic wiring (Settings.wireInputs — extracted from the settings pages
// in v0.30), and the same document-level fmt-input + doomalay:action
// handlers, which branch on data-scope="chat" to write into THIS module's
// store instead of the global Settings. One UI, one method, two stores.
//
// OVERRIDE MODEL: a new chat inherits the global settings (its tweak blob
// is empty). Every value the user touches here becomes a per-chat
// override, applied as INLINE CSS variables on #chat-root — the cascade
// hands them to the chat subtree alone, so the rest of the app (and every
// other chat) keeps the global look. "inherit … again" buttons drop the
// overrides back to the global values.
//
// STORAGE (engine-side, next to the chat's own session):
//   GET/PUT   /api/sessions/{id}/tweaks      the JSON blob (only the
//                                            overridden keys are present)
//   GET/PUT/DELETE /api/sessions/{id}/background   the image bytes (the
//                                            client downscales to ≤1600px
//                                            before upload; the URL is
//                                            cache-busted with ?v=<rev>)
//
// Exposes: window.ChatTweaks = { open, attach, setScheme, setFmtSlot,
//                                setSize, resetColors, resetSizes,
//                                setBgColor, clearBg }

(function () {
  'use strict';

  var Settings = window.Settings;

  // the CSS variables this module manages on #chat-root (all cleared
  // before each apply — an absent override must fall back to the GLOBAL
  // value, which lives on :root)
  var FMT_VARS = ['--fmt-a1', '--fmt-a2', '--fmt-a3', '--fmt-bright', '--fmt-link'];
  var SIZE_VARS = ['--chat-fs', '--chat-scale', '--ui-fs', '--ui-small-fs'];
  var SIZES = [
    { key: 'chatTextSize', cssVar: '--chat-fs', lo: 12, span: 12 },   // 0-100 → 12-24px
    { key: 'uiTextSize', cssVar: '--ui-fs', lo: 12, span: 5 },        // 0-100 → 12-17px
    { key: 'smallTextSize', cssVar: '--ui-small-fs', lo: 9.5, span: 5.5 } // 0-100 → 9.5-15px
  ];

  // v0.34: the chat text slider's companion ratio (chat-fs ÷ 16px) —
  // every message-scope px multiplies by it (see index.html), so bubbles,
  // code cards and spacing scale TOGETHER with the text.
  function chatScaleOf(v) { return ((12 + (v / 100) * 12) / 16).toFixed(3); }

  // ── the effective values (per-chat override ?? global) ───────────
  // Mirrors theme.js's pendingScheme logic for the global fallback so
  // the tweaks view shows exactly what the chat renders.
  function globalEffectiveScheme() {
    var s = Settings.getState();
    var pinned = (s.chatScheme && s.chatScheme !== 'teal') ||
      (s.fmtOverrides && Object.keys(s.fmtOverrides).length > 0);
    if (pinned) return s.chatScheme || 'teal';
    var themes = (window.DoomTheme && window.DoomTheme.themes) || {};
    var id = themes[s.theme] ? s.theme : 'midnight';
    return themes[id].scheme || 'teal';
  }

  function effective(state) {
    var t = (state && state._tweaks) || {};
    var g = Settings.getState();
    var scheme = (t.chatScheme != null) ? t.chatScheme : globalEffectiveScheme();
    var preset = (window.Formatter && window.Formatter.schemes[scheme]) ||
      (window.Formatter && window.Formatter.schemes.teal) || {};
    var gov = g.fmtOverrides || {};
    var tov = t.fmtOverrides || {};
    var fmt = {};
    ['a1', 'a2', 'a3', 'bright', 'link'].forEach(function (k) {
      fmt[k] = tov[k] || gov[k] || preset[k] || '#22d3ee';
    });
    var sizes = {};
    SIZES.forEach(function (d) {
      sizes[d.key] = (t[d.key] != null) ? t[d.key]
        : ((typeof g[d.key] === 'number') ? g[d.key] : 50);
    });
    return { chatScheme: scheme, fmt: fmt, sizes: sizes, bg: t.bg || null };
  }

  // ── APPLY — write the per-chat values onto #chat-root ────────────
  // The element reference lives on state (a stacked view stashes the root
  // DOM into a fragment — querySelector can't reach it then, but the
  // node still carries every style we paint onto it).
  function apply(state) {
    var root = state && state._chatRootEl;
    if (!root) return;
    FMT_VARS.concat(SIZE_VARS).forEach(function (v) { root.style.removeProperty(v); });
    var t = (state && state._tweaks) || {};
    var e = effective(state);

    // colors — only when THIS chat owns a scheme or any slot override;
    // otherwise the chat inherits the global --fmt-* from :root
    var ownSlots = t.fmtOverrides && Object.keys(t.fmtOverrides).length;
    if (t.chatScheme != null || ownSlots) {
      FMT_VARS.forEach(function (v, i) {
        root.style.setProperty(v, e.fmt[['a1', 'a2', 'a3', 'bright', 'link'][i]]);
      });
    }

    // text sizes — only the ones this chat overrides (same px math as
    // theme.js, so the slider = the pixels). The chat slider ALSO writes
    // --chat-scale so the whole message scope follows the font.
    SIZES.forEach(function (d) {
      if (t[d.key] != null) {
        root.style.setProperty(d.cssVar, (d.lo + (t[d.key] / 100) * d.span).toFixed(1) + 'px');
        if (d.key === 'chatTextSize') root.style.setProperty('--chat-scale', chatScaleOf(t[d.key]));
      }
    });

    // background — a color, a 1–10-stop gradient, or the engine-stored
    // image (cache-busted by rev)
    root.style.backgroundColor = '';
    root.style.backgroundImage = '';
    root.style.backgroundSize = '';
    root.style.backgroundPosition = '';
    var bg = t.bg;
    if (bg && bg.type === 'color' && bg.color) {
      root.style.backgroundColor = bg.color;
    } else if (bg && bg.type === 'gradient' && bg.colors && bg.colors.length) {
      // v0.33 (user spec): the chat background can be a gradient — up
      // to 10 colors, minimum 1 (one stop renders as a solid fill)
      if (bg.colors.length === 1) root.style.backgroundColor = bg.colors[0];
      else root.style.backgroundImage = 'linear-gradient(135deg,' + bg.colors.join(',') + ')';
    } else if (bg && bg.type === 'image' && state.sessionId) {
      root.style.backgroundImage = 'url("/api/sessions/' + state.sessionId +
        '/background?v=' + (bg.rev || 1) + '")';
      root.style.backgroundSize = 'cover';
      root.style.backgroundPosition = 'center';
    }
  }

  // ── STORE — load / persist the tweak blob ─────────────────────────
  function load(state) {
    if (!state) return Promise.resolve({});
    if (state._tweaksPromise) return state._tweaksPromise;
    if (!state.sessionId) {
      // PROVISIONAL: the session lands async (bindEngineSession) — a
      // chat opened before its bind resolves shows the global look for
      // now, and the bind's callback re-attaches to fetch the real blob.
      state._tweaks = {};
      state._tweaksLoaded = true;
      state._tweaksProvisional = true;
      return Promise.resolve({});
    }
    // a session arrived after the provisional load — fetch for real
    if (state._tweaksProvisional) {
      state._tweaksLoaded = false;
      state._tweaksProvisional = false;
    }
    if (state._tweaksLoaded) return Promise.resolve(state._tweaks);
    state._tweaksPromise = fetch('/api/sessions/' + state.sessionId + '/tweaks')
      .then(function (r) { return r.json(); })
      .then(function (d) {
        state._tweaks = (d && d.tweaks && typeof d.tweaks === 'object') ? d.tweaks : {};
        state._tweaksLoaded = true;
        state._tweaksPromise = null;
        apply(state);
        return state._tweaks;
      })
      .catch(function () {
        state._tweaks = {};
        state._tweaksLoaded = true;
        state._tweaksPromise = null;
        return {};
      });
    return state._tweaksPromise;
  }

  var saveTimer = null;
  function persist(state) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      if (!state || !state._tweaksLoaded) return;
      var save = function () {
        if (!state.sessionId) return; // no session yet — retried on attach
        fetch('/api/sessions/' + state.sessionId + '/tweaks', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(state._tweaks || {})
        }).catch(function (e) { console.warn('tweaks save failed', e); });
      };
      if (state.sessionId) return save();
      // first customization before the first message — create the session
      // (the same creator the send path uses), then save into it
      if (window.ChatPanel && window.ChatPanel.ensureSession) {
        window.ChatPanel.ensureSession(state, save);
      }
    }, 250);
  }

  // ── writers (the scoped handlers in appearance.js + this view call these) ──
  function touch(state) {
    if (!state._tweaksLoaded) state._tweaksLoaded = true;
    if (!state._tweaks) state._tweaks = {};
  }

  function setScheme(state, id) {
    touch(state);
    state._tweaks.chatScheme = id;
    apply(state);
    persist(state);
    rerenderView(); // v0.34: the fmt color rows + swatch selection update NOW
  }

  function setFmtSlot(state, slot, hex) {
    touch(state);
    var ov = state._tweaks.fmtOverrides || {};
    ov[slot] = hex;
    state._tweaks.fmtOverrides = ov;
    apply(state);
    persist(state);
  }

  function setSize(state, key, v) {
    // only the three known scales — the generic wiring forwards whatever
    // data-setting-key it finds, and a stray key must not enter the blob
    if (key !== 'chatTextSize' && key !== 'uiTextSize' && key !== 'smallTextSize') return;
    touch(state);
    state._tweaks[key] = Math.max(0, Math.min(100, Math.round(Number(v) || 0)));
    apply(state);
    persist(state);
  }

  function resetColors(state) {
    touch(state);
    delete state._tweaks.chatScheme;
    delete state._tweaks.fmtOverrides;
    apply(state);
    persist(state);
    rerenderView(); // v0.34: "inherit the global colors again" repaints the rows in place
  }

  function resetSizes(state) {
    touch(state);
    SIZES.forEach(function (d) { delete state._tweaks[d.key]; });
    apply(state);
    persist(state);
    rerenderView(); // v0.34: "inherit the global sizes again" snaps the sliders in place
  }

  function setBgColor(state, hex) {
    touch(state);
    state._tweaks.bg = { type: 'color', color: hex };
    apply(state);
    persist(state);
  }

  // v0.33: the chat background GRADIENT — 1–10 colors (the shared
  // GradientUI owns the editor; this just persists + applies).
  function setBgGradient(state, colors) {
    touch(state);
    var stops = [];
    (colors || []).forEach(function (c) { if (c) stops.push(c); });
    if (!stops.length) return;
    state._tweaks.bg = { type: 'gradient', colors: stops.slice(0, 10) };
    apply(state);
    persist(state);
  }

  function clearBg(state) {
    touch(state);
    delete state._tweaks.bg;
    bgMode = 'color';   // back to the default segment
    if (state.sessionId) {
      fetch('/api/sessions/' + state.sessionId + '/background', { method: 'DELETE' })
        .catch(function () {});
    }
    apply(state);
    persist(state);
  }

  // ── the image pipeline: pick → downscale → upload → apply ─────────
  // A library photo is 3-12MP; the panel doesn't need it. Downscale to
  // ≤1600px on the long edge and re-encode as JPEG — typically 100-400KB,
  // comfortably inside the engine's 4MB cap and quick to fetch on chat
  // open (it's also cached forever per ?v=rev).
  function downscaleImage(file, maxEdge) {
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
          cv.toBlob(function (blob) {
            URL.revokeObjectURL(url);
            if (blob) resolve(blob); else reject(new Error('encode failed'));
          }, 'image/jpeg', 0.85);
        } catch (e) { URL.revokeObjectURL(url); reject(e); }
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('not readable')); };
      img.src = url;
    });
  }

  function uploadBackground(state, blob) {
    return fetch('/api/sessions/' + state.sessionId + '/background', {
      method: 'PUT',
      headers: { 'Content-Type': 'image/jpeg' },
      body: blob
    }).then(function (r) {
      if (!r.ok) throw new Error('upload failed (' + r.status + ')');
      return r.json();
    }).then(function (d) {
      touch(state);
      state._tweaks.bg = { type: 'image', rev: (d && d.rev) || 1 };
      bgMode = 'image';   // the segment follows the fresh upload
      apply(state);
      persist(state);
    });
  }

  // ── attach — the chat host calls this on every render ─────────────
  function attach(state) {
    if (!state) return;
    load(state).then(function () { apply(state); });
  }

  // ── THE VIEW ──────────────────────────────────────────────────────
  var cur = null;      // { panel, icon, state } while the view is open
  var bgMode = null;   // the Background segment's pick (color/gradient/image)
  var gradDraft = null; // the gradient editor's live colors (pre-apply)

  function open(panel, icon, state) {
    if (!panel || !state) return;
    cur = { panel: panel, icon: icon, state: state };
    bgMode = null;     // re-derived from the stored blob on each open
    gradDraft = null;
    load(state).then(function () {
      if (cur && cur.state === state && panel.viewDepth && panel.viewDepth() >= 0) {
        panel.pushView(buildView());
      }
    });
  }

  // the gradient editor's colors: the stored gradient, else a fresh
  // pair draft (the familiar 2 — the ↻ random button varies the count)
  function gradColorsFor(t) {
    if (t.bg && t.bg.type === 'gradient' && t.bg.colors && t.bg.colors.length) {
      return t.bg.colors;
    }
    if (!gradDraft) {
      gradDraft = (window.GradientUI || { random: function () { return ['#38bdf8', '#a78bfa']; } }).random(2);
    }
    return gradDraft;
  }
  function gradPreviewStyle(t) {
    var c = gradColorsFor(t);
    if (window.GradientUI) {
      var css = window.GradientUI.css(c);
      return c.length === 1 ? ('background-color:' + css) : ('background-image:' + css);
    }
    return 'background-image:linear-gradient(135deg,' + c.join(',') + ')';
  }
  function bgSegPill(mode, label) {
    var on = (bgMode === mode);
    return '<button type="button" class="dx-pill dx-pill--sm" data-bgmode="' + mode + '"' +
      (on ? ' data-on="1"' : '') + '>' + label + '</button>';
  }

  // rebuild() — re-render the view, PRESERVING which sections are
  // expanded + the scroll position (settings.js's rerender pattern; the
  // v0.33 gradient editor rebuilds on every add/remove — the sections
  // must not fold up under the user's thumbs mid-edit).
  function rebuild() {
    if (!cur || !cur.panel || !cur.panel.replaceView) return;
    var body = cur.panel.bodyEl;
    var openTitles = [];
    if (body) {
      body.querySelectorAll('.settings-section.expanded').forEach(function (s) {
        var h = s.querySelector('h3');
        if (h) openTitles.push(h.textContent.trim());
      });
    }
    var scroll = body ? body.scrollTop : 0;
    cur.panel.replaceView(buildView());
    requestAnimationFrame(function () {
      if (!cur || !cur.panel) return;
      var nb = cur.panel.bodyEl;
      if (!nb) return;
      nb.querySelectorAll('.settings-section').forEach(function (s) {
        var h = s.querySelector('h3');
        if (h && openTitles.indexOf(h.textContent.trim()) >= 0) s.classList.add('expanded');
      });
      nb.scrollTop = scroll;
    });
  }

  // v0.34: LIVE RE-RENDER — the same fix the settings screen got in
  // v0.26: every scoped mutation (preset pick, "inherit … again") rebuilds
  // the open tweaks view so the sliders/swatches reflect the change
  // IMMEDIATELY (they used to keep stale values until close/re-open).
  // rebuild() preserves the expanded sections + the scroll position.
  function rerenderView() {
    if (!cur || !cur.panel || typeof cur.panel.viewDepth !== 'function') return rebuild();
    if (cur.panel.viewDepth() <= 0) return; // view already gone — nothing to paint
    rebuild();
  }

  function buildView() {
    var icon = cur.icon, state = cur.state;
    return {
      title: 'tweaks · ' + icon.name,
      render: function () {
        var A = window.AppearanceUI || {};
        var sec = A.section || function (t, inner) { return '<div>' + inner + '</div>'; };
        var e = effective(state);
        var t = state._tweaks || {};
        var own = t.fmtOverrides || {};
        var bgSet = !!t.bg;
        var bgIsImage = !!(t.bg && t.bg.type === 'image');
        var bgIsGradient = !!(t.bg && t.bg.type === 'gradient');
        if (!bgMode) bgMode = (t.bg && t.bg.type) || 'color';
        var curBgColor = (t.bg && t.bg.type === 'color' && t.bg.color) ||
          ((state._chatRootEl && rgbToHex(state._chatRootEl, 'background-color')) || '#0a0a0b');
        return (
          '<p class="pv-hint">this chat\'s own look — it starts as a copy of the global settings; anything you change here overrides them for <b>' + esc(icon.name) + '</b> only. Other chats keep the global look.</p>' +
          sec('Chat Colors',
            '<p class="hint">The markdown color scheme for this chat\'s messages — a family of 2–3 adjacent hues. Pick a preset, or fine-tune every slot below.</p>' +
            (A.schemeChatSwatches ? A.schemeChatSwatches(e.chatScheme, 'chat') : '') +
            (A.fmtColorRow ? (
              A.fmtColorRow('a1', 'Accent 1', 'headings · keywords', e.fmt.a1, !!own.a1, 'chat') +
              A.fmtColorRow('a2', 'Accent 2', 'subheads · code', e.fmt.a2, !!own.a2, 'chat') +
              A.fmtColorRow('a3', 'Accent 3', 'emphasis · links', e.fmt.a3, !!own.a3, 'chat') +
              A.fmtColorRow('bright', 'Bright text', 'bold', e.fmt.bright, !!own.bright, 'chat') +
              A.fmtColorRow('link', 'Links', '', e.fmt.link, !!own.link, 'chat')
            ) : '') +
            '<button data-action="chat-colors-reset" data-scope="chat" style="background:transparent;border:1px solid var(--border);color:var(--text-3);padding:8px 14px;border-radius:8px;font-size:calc(var(--ui-small-fs) - 1px);font-family:inherit;cursor:pointer;margin-top:6px;width:100%">inherit the global colors again</button>'
          ) +
          sec('Text Size',
            '<p class="hint">The three text scales, scoped to this chat. Chat text rides the message bubbles; general + small cover the header, pills and input bar inside this panel.</p>' +
            (A.sizeSlider ? (
              A.sizeSlider('chatTextSize', 'Chat text', 'Message bubbles · 0 = 12px · 100 = 24px.', e.sizes.chatTextSize, 'chat') +
              A.sizeSlider('uiTextSize', 'General text', 'Labels, buttons, headers · 0 = 12px · 100 = 17px.', e.sizes.uiTextSize, 'chat') +
              A.sizeSlider('smallTextSize', 'Small text', 'Pills, hints, meta, thinking bubbles · 0 = 9.5px · 100 = 15px.', e.sizes.smallTextSize, 'chat')
            ) : '') +
            '<button data-action="tweaks-sizes-reset" data-scope="chat" style="background:transparent;border:1px solid var(--border);color:var(--text-3);padding:8px 14px;border-radius:8px;font-size:calc(var(--ui-small-fs) - 1px);font-family:inherit;cursor:pointer;margin-top:6px;width:100%">inherit the global sizes again</button>'
          ) +
          sec('Background',
            '<p class="hint">The surface behind this chat — a color, a gradient (1–10 colors), or an image from your library.</p>' +
            '<div class="tw-bgseg">' +
              bgSegPill('color', '● color') +
              bgSegPill('gradient', '◨ gradient') +
              bgSegPill('image', '🖼 image') +
            '</div>' +
            '<div data-bgzone="color"' + (bgMode !== 'color' ? ' style="display:none"' : '') + '>' +
              '<div class="setting-row">' +
                '<label>Background color</label>' +
                '<div class="control">' +
                  '<input type="color" data-bg-color value="' + curBgColor + '">' +
                  '<span class="color-hex" data-color-hex="bgColor">' + curBgColor + '</span>' +
                '</div>' +
              '</div>' +
            '</div>' +
            '<div data-bgzone="gradient"' + (bgMode !== 'gradient' ? ' style="display:none"' : '') + '>' +
              (window.GradientUI
                ? window.GradientUI.editor('tw', gradColorsFor(t)) +
                  '<div class="gr-preview" id="tw-grad-preview" style="' + gradPreviewStyle(t) + '"></div>'
                : '<p class="hint">the gradient editor is not available</p>') +
            '</div>' +
            '<div data-bgzone="image"' + (bgMode !== 'image' ? ' style="display:none"' : '') + '>' +
              '<button id="tweaks-bg-pick" style="background:var(--surface-2);border:1px solid var(--border);color:var(--text-1);padding:12px 14px;min-height:44px;border-radius:10px;font-size:var(--ui-small-fs);font-family:inherit;cursor:pointer;width:100%;margin-top:8px">🖼 choose an image from the library</button>' +
              '<input type="file" id="tweaks-bg-file" accept="image/*" style="display:none">' +
            '</div>' +
            (bgSet ? '<button id="tweaks-bg-remove" style="background:transparent;border:1px solid var(--border);color:var(--text-3);padding:10px 14px;min-height:44px;border-radius:10px;font-size:var(--ui-small-fs);font-family:inherit;cursor:pointer;width:100%;margin-top:8px">' +
              (bgIsImage ? '✕ remove the background image' :
               bgIsGradient ? '✕ remove the background gradient' :
               '✕ remove the background color') + '</button>' : '') +
            '<p class="hint" id="tweaks-bg-status" style="margin:8px 0 0">' +
              (bgIsImage ? 'an image is set — it fills the panel behind the messages.' :
               bgIsGradient ? 'a gradient is set — ' + t.bg.colors.length +
                 (t.bg.colors.length === 1 ? ' color.' : ' colors.') :
               bgSet ? 'a color is set.' :
               'nothing set — this chat follows the app background.') + '</p>'
          )
        );
      },
      onMount: function (el) {
        // THE SAME WIRING the settings pages use — sliders + section
        // toggles + action dispatch; the apply patch writes into the
        // per-chat store instead of the global one.
        if (window.Settings && window.Settings.wireInputs) {
          window.Settings.wireInputs(el, function (patch) {
            for (var k in patch) setSize(state, k, patch[k]);
          });
        }
        var t0 = state._tweaks || {};

        // v0.33: the Background segment — color / gradient / image.
        // The zones all exist in the DOM (the v30 pipeline drives them
        // headlessly); the segment just shows one at a time.
        el.querySelectorAll('[data-bgmode]').forEach(function (b) {
          b.addEventListener('click', function () {
            var mode = b.getAttribute('data-bgmode');
            bgMode = mode;
            el.querySelectorAll('[data-bgmode]').forEach(function (x) {
              if (x.getAttribute('data-bgmode') === mode) x.setAttribute('data-on', '1');
              else x.removeAttribute('data-on');
            });
            el.querySelectorAll('[data-bgzone]').forEach(function (z) {
              z.style.display = (z.getAttribute('data-bgzone') === mode) ? '' : 'none';
            });
          });
        });

        // the gradient editor — live preview updates in place; shape
        // changes (add/remove/shuffle/random) rebuild + PERSIST
        var gr = el.querySelector('#tw-gr');
        if (gr && window.GradientUI) {
          var colors = gradColorsFor(t0);
          window.GradientUI.wire(gr, {
            colors: colors,
            live: function () {
              setBgGradient(state, colors);
              var pv = el.querySelector('#tw-grad-preview');
              if (pv) {
                var css = window.GradientUI.css(colors);
                pv.setAttribute('style', colors.length === 1
                  ? ('background-color:' + css) : ('background-image:' + css));
              }
            },
            rebuild: function () {
              setBgGradient(state, colors);
              rebuild();
            }
          });
        }

        var bgc = el.querySelector('[data-bg-color]');
        if (bgc) bgc.addEventListener('input', function () {
          setBgColor(state, bgc.value);
          var hex = el.querySelector('[data-color-hex="bgColor"]');
          if (hex) hex.textContent = bgc.value;
        });
        var pick = el.querySelector('#tweaks-bg-pick');
        var file = el.querySelector('#tweaks-bg-file');
        var status = el.querySelector('#tweaks-bg-status');
        if (pick && file) {
          pick.addEventListener('click', function () { file.click(); });
          file.addEventListener('change', function () {
            var f = file.files && file.files[0];
            if (!f) return;
            if (status) status.textContent = 'downscaling + uploading…';
            var go = function () {
              downscaleImage(f, 1600).then(function (blob) {
                return uploadBackground(state, blob);
              }).then(function () {
                rebuild();
              }).catch(function (err) {
                if (status) status.textContent = 'couldn\u2019t set that image — ' + (err && err.message ? err.message : 'try another');
              });
            };
            if (state.sessionId) return go();
            if (window.ChatPanel && window.ChatPanel.ensureSession) {
              window.ChatPanel.ensureSession(state, go);
            }
          });
        }
        var rm = el.querySelector('#tweaks-bg-remove');
        if (rm) rm.addEventListener('click', function () {
          clearBg(state);
          rebuild();
        });
      }
    };
  }

  // ── helpers ────────────────────────────────────────────────────────
  function rgbToHex(el, prop) {
    try {
      var m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(getComputedStyle(el)[prop] || '');
      if (!m) return '';
      return '#' + [1, 2, 3].map(function (i) {
        return ('0' + parseInt(m[i], 10).toString(16)).slice(-2);
      }).join('');
    } catch (e) { return ''; }
  }

  // v0.38 PER-CHAT UI DEFAULTS (user spec): each chat remembers whether
  // the user prefers the thinking / sources / tool-pill boxes expanded or
  // collapsed — stored in the chat's own tweaks blob as uiState, applied on
  // every render.
  function setUiState(state, key, v) {
    touch(state);
    var ui = state._tweaks.uiState || {};
    ui[key] = v;
    state._tweaks.uiState = ui;
    persist(state);
  }
  function uiStateOf(state) {
    var t = state && state._tweaks;
    return (t && t.uiState && typeof t.uiState === 'object') ? t.uiState : null;
  }

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  // the scoped handlers (appearance.js) forward here with the live state
  // of the view that dispatched them
  function withState(fn) {
    return function () {
      if (!cur) return;
      fn.apply(null, [cur.state].concat([].slice.call(arguments)));
    };
  }

  window.ChatTweaks = {
    open: open,
    attach: attach,
    // v0.38: per-chat box preferences — ChatPanel calls these with an
    // EXPLICIT state (not the attached view state) so background turns
    // never write the foreground chat's prefs.
    setUiState: setUiState,
    uiStateOf: uiStateOf,
    setScheme: withState(setScheme),
    setFmtSlot: withState(setFmtSlot),
    setSize: withState(setSize),
    resetColors: withState(resetColors),
    resetSizes: withState(resetSizes),
    setBgColor: withState(setBgColor),
    setBgGradient: withState(setBgGradient),
    clearBg: withState(clearBg),
    effective: effective,
    apply: apply
  };
})();
