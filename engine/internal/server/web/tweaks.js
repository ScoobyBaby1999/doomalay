// tweaks.js — v0.30→v0.44 THE PER-CHAT SETTINGS (the ✦ tweaks pill).
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
// v0.44 USER SPECS: "When an image is pressed for background, we don't
// get the ask to crop and fit the image as the user pleases… Everytime
// the user selects to upload an image anywhere on the app… the user is
// redirected to crop and fit the image to the aspect ratio of whatever
// bubble/screen/borders it applies to" → every background pick now runs
// through CropUI at the LIVE chat-root aspect (the viewport as the
// fallback). And "tweaking the per chat gradients… use the gradient
// system" → the Background segment is ONE gradient editor (the shared
// GradientUI v2 — a 1-color spec IS the solid case, so the old color /
// gradient pills merged) with the full style / pattern / angle / texture
// rows. The texture uploads to the engine
// (PUT/GET/DELETE /api/sessions/{id}/texture — a rev'd row like the
// background) and composes into the root's background-image as the
// bottom layer with background-blend-mode: color.
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
//                                            overridden keys are present;
//                                            bg = {type:'gradient',
//                                            colors, dir, angle?, texRev?}
//                                            — legacy {type:'color',color}
//                                            and {type:'gradient',colors}
//                                            blobs load via GradientUI.norm)
//   GET/PUT/DELETE /api/sessions/{id}/background   the image bytes (the
//                                            CropUI crop ≤1600px; the
//                                            URL is cache-busted with
//                                            ?v=<rev>)
//   GET/PUT/DELETE /api/sessions/{id}/texture      the gradient's texture
//                                            (≤512px from the shared uikit
//                                            pipeline; ?v=<rev>)
//
// Exposes: window.ChatTweaks = { open, attach, setScheme, setFmtSlot,
//                                setSize, resetColors, resetSizes,
//                                setBgColor, setBgGradient, clearBg }

(function () {
  'use strict';

  var Settings = window.Settings;

  // the CSS variables this module manages on #chat-root (all cleared
  // before each apply — an absent override must fall back to the GLOBAL
  // value, which lives on :root). v0.44: the fmt slots carry their
  // GRADIENT twins too (--fmt-x-gradient / --fmt-x-ink) + the
  // data-fmt-grad attribute — the same trio formatter.js writes on
  // :root; the index.html [data-fmt-grad~=…] text-clip rules match the
  // attribute on ANY ancestor, so per-chat gradient text works.
  var FMT_VARS = ['--fmt-a1', '--fmt-a2', '--fmt-a3', '--fmt-bright', '--fmt-link'];
  var FMT_TWIN_VARS = [];
  ['a1', 'a2', 'a3', 'bright', 'link'].forEach(function (k) {
    FMT_TWIN_VARS.push('--fmt-' + k + '-gradient', '--fmt-' + k + '-ink');
  });
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
    FMT_VARS.concat(FMT_TWIN_VARS).forEach(function (v) { root.style.removeProperty(v); });
    root.removeAttribute('data-fmt-grad');
    var t = (state && state._tweaks) || {};
    var e = effective(state);

    // colors — only when THIS chat owns a scheme or any slot override;
    // otherwise the chat inherits the global --fmt-* from :root.
    // v0.44: slots resolve through the GRADIENT twins (a spec override
    // paints gradient text; a hex override paints solid — the same
    // fmtTwins() formatter.js uses, exposed for exactly this path).
    var ownSlots = t.fmtOverrides && Object.keys(t.fmtOverrides).length;
    if (t.chatScheme != null || ownSlots) {
      var twinsOf = (window.Formatter && window.Formatter.fmtTwins) ||
        function (raw) { return { solid: raw, grad: 'none' }; };
      var gradSlots = [];
      FMT_VARS.forEach(function (v, i) {
        var slot = ['a1', 'a2', 'a3', 'bright', 'link'][i];
        var twins = twinsOf(e.fmt[slot]);
        root.style.setProperty(v, twins.solid);
        root.style.setProperty(v + '-gradient', twins.grad);
        if (twins.grad !== 'none') {
          gradSlots.push(slot);
          root.style.setProperty(v + '-ink', 'transparent');
        }
      });
      if (gradSlots.length) root.setAttribute('data-fmt-grad', gradSlots.join(' '));
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

    // background — v0.44: a full gradient SPEC (one color + a plain
    // style = the solid case — exactly the v0.30 behavior), a spec with
    // an engine texture, or the engine-stored image (cache-busted by
    // rev). Legacy blobs fold through GradientUI.norm (old
    // {type:'color'} → a 1-color spec; old {type:'gradient',colors} →
    // dir 'auto' = the old 135° linear sweep).
    root.style.backgroundColor = '';
    root.style.backgroundImage = '';
    root.style.backgroundSize = '';
    root.style.backgroundPosition = '';
    root.style.backgroundBlendMode = '';
    var bg = t.bg;
    if (bg && bg.type === 'color' && typeof bg.color === 'string') {
      // legacy v0.30 blob — fold it into the v0.44 spec shape (in
      // memory; the next save persists the folded form)
      bg = { type: 'gradient', colors: [bg.color], dir: 'auto' };
    }
    if (bg && bg.type === 'gradient') {
      var GU = window.GradientUI;
      if (GU) {
        var spec = GU.norm({ colors: bg.colors, dir: bg.dir, angle: bg.angle });
        if (bg.texRev && state.sessionId) {
          // the texture lives on the ENGINE (rev'd row) — css() builds
          // the gradient layers (tex is NOT in the spec), the URL layer
          // is appended by hand and blend-mode 'color' inks the gradient
          // over the texture's luminance (the uikit BLENDED contract)
          root.style.backgroundImage = bgGradientLayers(spec) +
            ', url("/api/sessions/' + state.sessionId + '/texture?v=' + bg.texRev + '")';
          root.style.backgroundSize = 'cover';
          root.style.backgroundPosition = 'center';
          root.style.backgroundBlendMode = GU.BLENDED ? 'color' : '';
        } else {
          var css = GU.css(spec);
          if (css.charAt(0) === '#') {
            // 1 color + a plain style (any of auto/h/v/diag/diag2/radial)
            // → the solid fill — the old 'color' segment's behavior
            root.style.backgroundColor = css;
          } else {
            root.style.backgroundImage = css;
          }
        }
      } else {
        // uikit missing — the v0.33 fallback render
        var cols = (bg.colors && bg.colors.length) ? bg.colors : [];
        if (cols.length === 1) root.style.backgroundColor = cols[0];
        else if (cols.length) root.style.backgroundImage = 'linear-gradient(135deg,' + cols.join(',') + ')';
      }
    } else if (bg && bg.type === 'image' && state.sessionId) {
      root.style.backgroundImage = 'url("/api/sessions/' + state.sessionId +
        '/background?v=' + (bg.rev || 1) + '")';
      root.style.backgroundSize = 'cover';
      root.style.backgroundPosition = 'center';
    }
  }

  // bgGradientLayers(spec) — the background-image LAYERS for a spec
  // (no tex): GradientUI.css returns the bare hex for a 1-color plain
  // spec, which is background-color material — under a texture URL it
  // becomes a flat 2-stop layer so the css stack stays valid.
  function bgGradientLayers(spec) {
    var css = window.GradientUI.css(spec);
    if (css.charAt(0) === '#') {
      return 'linear-gradient(' + css + ',' + css + ')';
    }
    return css;
  }

  // ── STORE — load / persist the tweak blob ─────────────────────────

  // foldLegacyBg — v0.44 read-time migration: a stored v0.30
  // {type:'color',color} blob becomes the 1-color gradient spec (the
  // solid case) the moment it loads, so the store converges on the new
  // shape with the next save (apply() folds defensively too — a blob
  // written by an older build between loads still renders right).
  function foldLegacyBg(state) {
    var t = state && state._tweaks;
    var bg = t && t.bg;
    if (bg && bg.type === 'color' && typeof bg.color === 'string') {
      t.bg = { type: 'gradient', colors: [bg.color], dir: 'auto' };
    }
  }

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
        foldLegacyBg(state);
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

  // ── v0.52: the Bot Library boxes (dt_hublib gating) ───────────────────
  // Absent = ENABLED — every pre-boxes chat keeps full bot library access,
  // and the tool re-reads the blob on EVERY call ("on the fly": flip a
  // switch mid-conversation and the next hublib call obeys). Only these two
  // keys may enter the blob through this path.
  var BOX_KEYS = ['botTemplates', 'botSkills'];

  function setBox(state, key, v) {
    if (BOX_KEYS.indexOf(key) < 0) return;
    touch(state);
    state._tweaks[key] = !!v;
    persist(state);
  }

  // a switch row in the shared appearance.js style — theme vars only.
  function boxRow(key, label, hint, checked) {
    return '<div class="setting-row" style="align-items:center;justify-content:space-between;gap:10px">' +
      '<span style="min-width:0"><label>' + label + '</label>' +
        (hint ? '<p class="hint" style="margin:2px 0 0">' + hint + '</p>' : '') + '</span>' +
      '<label class="app-switch" style="position:relative;display:inline-block;width:42px;height:24px;flex-shrink:0">' +
        '<input type="checkbox" data-box-key="' + key + '"' + (checked ? ' checked' : '') +
          ' style="opacity:0;width:0;height:0;position:absolute">' +
        '<span class="app-switch-track" style="position:absolute;inset:0;background:' + (checked ? 'var(--accent)' : 'var(--surface-3)') +
          ';border-radius:12px;transition:background 0.15s"></span>' +
        '<span class="app-switch-thumb" style="position:absolute;top:2px;left:' + (checked ? '20px' : '2px') +
          ';width:20px;height:20px;background:var(--on-accent);border-radius:50%;transition:left 0.15s"></span>' +
      '</label>' +
    '</div>';
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

  // v0.49 (user spec: "add an option to reset text sizes and background in
  // the chat tweaks to default or inherent from global"): resetAll drops
  // EVERY per-chat override — scheme, fmt slots, the three sizes AND the
  // background (gradient/image/texture, uploaded assets included) — so
  // the chat follows the global settings again.
  function resetAll(state) {
    touch(state);
    delete state._tweaks.chatScheme;
    delete state._tweaks.fmtOverrides;
    SIZES.forEach(function (d) { delete state._tweaks[d.key]; });
    if (state._tweaks.bg) {
      if (state.sessionId) {
        fetch('/api/sessions/' + state.sessionId + '/background', { method: 'DELETE' })
          .catch(function () {});
        fetch('/api/sessions/' + state.sessionId + '/texture', { method: 'DELETE' })
          .catch(function () {});
      }
      delete state._tweaks.bg;
    }
    bgMode = 'gradient';
    gradDraft = null;
    apply(state);
    persist(state);
    rerenderView();
  }

  // setBgColor — the public writer kept for external callers; v0.44
  // re-routes it through the gradient system (a 1-color spec IS the
  // solid — the stored blob is now always a gradient spec).
  function setBgColor(state, hex) {
    if (!window.GradientUI) return;
    setBgGradient(state, { colors: [hex], dir: 'auto' });
  }

  // v0.33→v0.44: the chat background GRADIENT — a full spec (colors +
  // dir + angle). Accepts BOTH shapes (legacy callers pass a plain
  // colors array — GradientUI.norm folds every shape); the editor's
  // live spec object carries texRev as an extra key, and an input
  // object with an EXPLICIT texRev key is authoritative (null clears
  // it), otherwise a previously stored texRev survives — the texture
  // row is orthogonal to the colors.
  function setBgGradient(state, specOrColors) {
    var GU = window.GradientUI;
    if (!GU) return;
    var spec = GU.norm(specOrColors);
    if (!spec.colors.length) return;
    touch(state);
    var texRev = null;
    if (specOrColors && typeof specOrColors === 'object' &&
        !Array.isArray(specOrColors) && specOrColors.hasOwnProperty('texRev')) {
      texRev = specOrColors.texRev || null;
    } else if (state._tweaks.bg && state._tweaks.bg.type === 'gradient' &&
        state._tweaks.bg.texRev) {
      texRev = state._tweaks.bg.texRev;
    }
    var bg = { type: 'gradient', colors: spec.colors, dir: spec.dir };
    if (typeof spec.angle === 'number') bg.angle = spec.angle;
    if (texRev) bg.texRev = texRev;
    state._tweaks.bg = bg;
    apply(state);
    persist(state);
  }

  function clearBg(state) {
    touch(state);
    delete state._tweaks.bg;
    bgMode = 'gradient';  // back to the default segment
    gradDraft = null;     // a removed gradient doesn't ghost back
    if (state.sessionId) {
      fetch('/api/sessions/' + state.sessionId + '/background', { method: 'DELETE' })
        .catch(function () {});
      // the gradient's texture row goes with it (the blob no longer
      // points at it — leaving it would orphan a rev'd kv row)
      fetch('/api/sessions/' + state.sessionId + '/texture', { method: 'DELETE' })
        .catch(function () {});
    }
    apply(state);
    persist(state);
  }

  // ── the image pipeline: pick → CROP → upload → apply ─────────────
  // v0.44 (user spec): every image pick runs through CropUI at the LIVE
  // chat-root aspect — the user crops and fits the photo to the exact
  // screen it fills, and the crop comes from the ORIGINAL pixels
  // (≤1600px long edge, PNG out) — no blind downscale step anymore.

  // b64ToBlob — CropUI's PNG output (raw base64) → a Blob for the PUT.
  function b64ToBlob(b64, mime) {
    try {
      var bin = atob(String(b64 || ''));
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new Blob([bytes], { type: mime || 'image/png' });
    } catch (e) { return null; }
  }

  // dataURLToBlob — the editor's texture pick (a dataURL string) → a
  // Blob (the mime from the data: prefix, e.g. image/jpeg).
  function dataURLToBlob(dataURL) {
    var m = /^data:([^;,]+)(;base64)?,(.*)$/.exec(String(dataURL || ''));
    if (!m || !m[2]) return null;          // only base64 data URLs
    return b64ToBlob(m[3], m[1]);
  }

  function uploadBackground(state, blob) {
    // the mime rides the blob's own type (CropUI → png, the texture
    // pipeline → jpeg); the engine sniffs the magic bytes anyway — the
    // Content-Type is advisory
    var mime = (blob && blob.type) || 'image/jpeg';
    if (mime.slice(0, 6) !== 'image/') mime = 'image/jpeg';
    return fetch('/api/sessions/' + state.sessionId + '/background', {
      method: 'PUT',
      headers: { 'Content-Type': mime },
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

  // uploadTexture — the gradient editor's texture pick (a dataURL the
  // uikit pipeline already downscaled to ≤512px JPEG) → the engine's
  // rev'd texture row → spec.texRev. On success the dataURL is CLEARED
  // (the blob never stores texture bytes) and the view rebuilds.
  function uploadTexture(state, spec) {
    var status = cur && cur.panel ? cur.panel.bodyEl.querySelector('#tweaks-bg-status') : null;
    if (status) status.textContent = 'uploading the texture…';
    var go = function () {
      var blob = dataURLToBlob(spec.tex);
      if (!blob) {
        spec.tex = null;
        if (status) status.textContent = 'couldn\u2019t read that texture — try another';
        setBgGradient(state, spec);
        rebuild();
        return;
      }
      fetch('/api/sessions/' + state.sessionId + '/texture', {
        method: 'PUT',
        headers: { 'Content-Type': blob.type || 'image/jpeg' },
        body: blob
      }).then(function (r) {
        if (!r.ok) throw new Error('upload failed (' + r.status + ')');
        return r.json();
      }).then(function (d) {
        spec.tex = null;                    // the bytes live on the engine now
        spec.texRev = (d && d.rev) || 1;   // the cache-busting handle
        setBgGradient(state, spec);
        rebuild();
      }).catch(function (err) {
        spec.tex = null;                    // the texture can't ride the blob — drop it
        if (status) status.textContent = 'couldn\u2019t add that texture — ' +
          (err && err.message ? err.message : 'try another');
        setBgGradient(state, spec);         // the other shape changes still persist
        rebuild();
      });
    };
    if (state.sessionId) return go();
    if (window.ChatPanel && window.ChatPanel.ensureSession) {
      window.ChatPanel.ensureSession(state, go);
    }
  }

  // ── v0.52: the CHAT ICON upload (user spec item 10) ──────────────
  // The square-cropped icon bytes → the engine's rev'd icon row; the
  // tweaks blob carries only {iconCustom:true, iconRev:N} (plus
  // iconIndex for the built-in picks) so it stays tiny.
  function uploadCustomIcon(state, blob) {
    var mime = (blob && blob.type) || 'image/png';
    if (mime.slice(0, 6) !== 'image/') mime = 'image/png';
    return fetch('/api/sessions/' + state.sessionId + '/icon', {
      method: 'PUT',
      headers: { 'Content-Type': mime },
      body: blob
    }).then(function (r) {
      if (!r.ok) throw new Error('upload failed (' + r.status + ')');
      return r.json();
    });
  }

  // iconCellsHTML — the built-in picks: the name letter (iconIndex -1,
  // always available) + every glyph of the chat's CURRENT family set
  // (families.json — the user's own default icon set drops in there).
  function iconCellsHTML(icon) {
    var cfg = window.DoomalayConfig;
    var fam = (cfg && cfg.families && cfg.families[icon.family]) || {};
    var icons = Array.isArray(fam.icons) ? fam.icons : [];
    var out = '';
    // the letter fallback — always first
    var letterOn = (!icon.iconCustom && !(icon.iconIndex >= 0));
    out += '<button type="button" class="tw-iconcell" data-iconidx="-1"' +
      (letterOn && !icon.iconCustom ? ' data-on="1"' : '') +
      ' title="the name letter"><span class="tw-iconcell-letter">' +
      esc((icon.name || '?').charAt(0).toUpperCase()) + '</span></button>';
    for (var i = 0; i < icons.length; i++) {
      var on = (!icon.iconCustom && icon.iconIndex === i);
      out += '<button type="button" class="tw-iconcell" data-iconidx="' + i + '"' +
        (on ? ' data-on="1"' : '') + ' title="family icon ' + (i + 1) + '">' +
        '<img src="' + icons[i] + '" alt=""></button>';
    }
    // the custom cell — reflects the engine-stored image when set
    if (icon.iconCustom && icon.sessionId) {
      out += '<button type="button" class="tw-iconcell" data-iconidx="custom" data-on="1"' +
        ' title="your image"><img src="' + icon.customIconURL() + '" alt=""></button>';
    }
    return '<div class="tw-icongrid" id="tw-icongrid">' + out + '</div>';
  }

  // ── attach — the chat host calls this on every render ─────────────
  function attach(state) {
    if (!state) return;
    load(state).then(function () { apply(state); });
  }

  // ── THE VIEW ──────────────────────────────────────────────────────
  var cur = null;      // { panel, icon, state } while the view is open
  var bgMode = null;   // the Background segment's pick (gradient/image)
  var gradDraft = null; // the gradient editor's live spec (pre-apply — a
                        // fresh pair until the first edit persists it)

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

  // the gradient editor's LIVE spec: the stored bg blob (any legacy
  // shape folded through GradientUI.norm — old color blobs become
  // 1-color specs, old gradient blobs get dir 'auto'), else a fresh
  // pair draft (the familiar 2 — the ↻ random button varies the count).
  // texRev rides along as an extra key: the editor never touches it,
  // setBgGradient reads it, and the ✕ texture row clears it.
  function bgSpecFor(t) {
    var GU = window.GradientUI;
    var bg = t && t.bg;
    if (GU && bg && (bg.type === 'gradient' || bg.type === 'color')) {
      // norm accepts the legacy shapes directly ({type:'color',color}
      // hands its hex through, {type:'gradient',…} is already a spec)
      var n = GU.norm(bg.type === 'color' ? bg.color : bg);
      var spec = { colors: n.colors, dir: n.dir, texRev: bg.texRev || null };
      if (typeof n.angle === 'number') spec.angle = n.angle;
      return spec;
    }
    if (!gradDraft) {
      var rnd = (GU || { random: function () { return ['var(--accent)', 'var(--accent-2)']; } }).random(2);
      gradDraft = { colors: rnd, dir: 'auto', texRev: null };
    }
    return gradDraft;
  }

  // the big preview strip under the editor — the same resolution order
  // apply() uses: a dataURL tex (mid-upload) → inline, texRev → the
  // engine URL layer + blend, 1-color plain → background-color, else css.
  function bgPreviewStyle(spec, state) {
    var GU = window.GradientUI;
    if (!GU) return 'background-image:linear-gradient(135deg,var(--accent),var(--accent-2))';
    if (spec.tex && typeof spec.tex === 'string') {
      // a picked texture waiting for its upload — show it inline
      var inlineCss = GU.css(spec);
      return inlineCss.charAt(0) === '#'
        ? 'background-color:' + inlineCss
        : 'background-image:' + inlineCss;
    }
    if (spec.texRev && state && state.sessionId) {
      return 'background-image:' + bgGradientLayers(GU.norm(spec)) +
        ',url("/api/sessions/' + state.sessionId + '/texture?v=' + spec.texRev + '")' +
        ';background-size:cover;background-position:center' +
        (GU.BLENDED ? ';background-blend-mode:color' : '');
    }
    var css = GU.css(spec);
    return css.charAt(0) === '#'
      ? ('background-color:' + css)
      : ('background-image:' + css);
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
        // v0.44: the color + gradient segments MERGED — a 1-color spec is
        // the solid, so legacy color blobs open the gradient editor too
        if (!bgMode) bgMode = bgIsImage ? 'image' : 'gradient';
        var gradSpec = bgSpecFor(t);
        return (
          '<p class="pv-hint">this chat\'s own look — it starts as a copy of the global settings; anything you change here overrides them for <b>' + esc(icon.name) + '</b> only. Other chats keep the global look.</p>' +
          '<button id="tweaks-reset-all" style="background:transparent;border:1px solid var(--border);color:var(--text-3);padding:10px 14px;min-height:44px;border-radius:10px;font-size:var(--ui-small-fs);font-family:inherit;cursor:pointer;width:100%;margin:2px 0 6px">↺ reset everything to the global look</button>' +
          sec('Chat Icon',
            '<p class="hint">The icon this chatbot wears on the grid and in the panel header — a built-in glyph, or any image from your library (square-cropped).</p>' +
            iconCellsHTML(icon) +
            '<button id="tweaks-icon-pick" style="background:var(--surface-2);border:1px solid var(--border);color:var(--text-1);padding:12px 14px;min-height:44px;border-radius:10px;font-size:var(--ui-small-fs);font-family:inherit;cursor:pointer;width:100%;margin-top:8px">🖼 browse an image…</button>' +
            '<input type="file" id="tweaks-icon-file" accept="image/*" style="display:none">' +
            (icon.iconCustom
              ? '<button id="tweaks-icon-remove" style="background:transparent;border:1px solid var(--border);color:var(--text-3);padding:10px 14px;min-height:44px;border-radius:10px;font-size:var(--ui-small-fs);font-family:inherit;cursor:pointer;width:100%;margin-top:6px">✕ back to the family icon</button>'
              : '') +
            '<p class="hint" id="tweaks-icon-status" style="margin:8px 0 0">' +
              (icon.iconCustom
                ? 'a custom image is set — it overrides the family glyph everywhere.'
                : 'no custom image — the family glyph (or the name letter) shows.') + '</p>'
          ) +
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
          sec('Bot Library',
            '<p class="hint">Whether this chat\'s bot may browse + download the PUBLIC HUB\'s community libraries (the hublib tool). Flips apply on the very next bot turn — no restart. Both default to on; a switch that was never touched stays on.</p>' +
            boxRow('botTemplates', 'Templates', 'the bot can browse + download method templates from the hub', t.botTemplates !== false) +
            boxRow('botSkills', 'Skills', 'the bot can browse + download methodology skills from the hub', t.botSkills !== false)
          ) +
          sec('Background',
            '<p class="hint">The surface behind this chat — a gradient (one color is the solid case; any style, pattern, angle or texture), or an image from your library, cropped to fit this screen.</p>' +
            '<div class="tw-bgseg">' +
              bgSegPill('gradient', '◨ gradient') +
              bgSegPill('image', '🖼 image') +
            '</div>' +
            '<div data-bgzone="gradient"' + (bgMode !== 'gradient' ? ' style="display:none"' : '') + '>' +
              (window.GradientUI
                ? window.GradientUI.editor('tw', gradSpec) +
                  (gradSpec.texRev
                    ? '<div class="setting-row" id="tw-tex-row" style="margin-top:8px">' +
                        '<label>texture set</label>' +
                        '<div class="control"><button type="button" id="tw-tex-rm" style="background:transparent;border:1px solid var(--border);color:var(--text-3);padding:8px 14px;min-height:44px;border-radius:10px;font-size:calc(var(--ui-small-fs) - 1px);font-family:inherit;cursor:pointer">✕ remove texture</button></div>' +
                      '</div>'
                    : '') +
                  '<div class="gr-preview" id="tw-grad-preview" style="' + bgPreviewStyle(gradSpec, state) + '"></div>'
                : '<p class="hint">the gradient editor is not available</p>') +
            '</div>' +
            '<div data-bgzone="image"' + (bgMode !== 'image' ? ' style="display:none"' : '') + '>' +
              '<button id="tweaks-bg-pick" style="background:var(--surface-2);border:1px solid var(--border);color:var(--text-1);padding:12px 14px;min-height:44px;border-radius:10px;font-size:var(--ui-small-fs);font-family:inherit;cursor:pointer;width:100%;margin-top:8px">🖼 choose an image from the library</button>' +
              '<input type="file" id="tweaks-bg-file" accept="image/*" style="display:none">' +
              '<p class="hint" style="margin:6px 0 0">the cropper opens at this screen\u2019s shape — fit the photo to the exact area it fills.</p>' +
            '</div>' +
            (bgSet ? '<button id="tweaks-bg-remove" style="background:transparent;border:1px solid var(--border);color:var(--text-3);padding:10px 14px;min-height:44px;border-radius:10px;font-size:var(--ui-small-fs);font-family:inherit;cursor:pointer;width:100%;margin-top:8px">' +
              (bgIsImage ? '✕ remove the background image' :
               '↺ inherit the global background again') + '</button>' : '') +
            '<p class="hint" id="tweaks-bg-status" style="margin:8px 0 0">' +
              (bgIsImage ? 'an image is set — it fills the panel behind the messages.' :
               bgIsGradient ? 'a gradient is set — ' + (t.bg.colors ? t.bg.colors.length : 0) +
                 ((t.bg.colors && t.bg.colors.length) === 1 ? ' color.' : ' colors.') +
                 (t.bg.texRev ? ' + texture.' : '.') :
               'nothing set — this chat follows the global background.') + '</p>'
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
        // v0.49 FIX (user-reported: "pressing a row or color to change
        // doesn't open our color theme system"): the collapsed color
        // rows' EXPAND toggles + per-row resets were wired only on the
        // settings pages (appearance.js's drain) — the tweaks view never
        // called the shared wirer, so tapping a color row here did
        // NOTHING. Wire them natively now (idempotent — the flags live
        // on the elements), plus the fmt gradient editors.
        if (window.AppearanceUI) {
          if (window.AppearanceUI.wireColorRows) window.AppearanceUI.wireColorRows(el);
          if (window.AppearanceUI.wireFmtEditors) window.AppearanceUI.wireFmtEditors(el);
        }
        var t0 = state._tweaks || {};

        // v0.52: the Bot Library boxes — flip the switch in place (track +
        // thumb), write through setBox (strict whitelist → blob → engine).
        el.querySelectorAll('input[data-box-key]').forEach(function (c) {
          c.addEventListener('change', function () {
            var on = c.checked;
            setBox(state, c.getAttribute('data-box-key'), on);
            var lab = c.parentElement;
            var track = lab && lab.querySelector('.app-switch-track');
            var thumb = lab && lab.querySelector('.app-switch-thumb');
            if (track) track.style.background = on ? 'var(--accent)' : 'var(--surface-3)';
            if (thumb) thumb.style.left = on ? '20px' : '2px';
          });
        });

        // v0.52 (user spec item 10): the CHAT ICON section — the built-in
        // cells + the browse-image crop flow (the SAME CropUI pipeline the
        // background uses, at aspect 1: the avatar clips circular).
        var refreshHeaderAvatar = function () {
          if (cur && cur.panel && cur.panel.avatarEl) {
            cur.panel.avatarEl.innerHTML = icon.getAvatarHTML();
          }
        };
        el.querySelectorAll('#tw-icongrid [data-iconidx]').forEach(function (cell) {
          cell.addEventListener('click', function () {
            var idx = cell.getAttribute('data-iconidx');
            if (idx === 'custom') return; // the custom cell is a state, not a pick
            var n = parseInt(idx, 10);
            var done = function () {
              icon.clearCustomIcon();               // falls back to the family set
              if (!isNaN(n)) icon.iconIndex = n;    // -1 = the letter
              icon._renderIcon();
              touch(state);
              state._tweaks.iconIndex = n;
              delete state._tweaks.iconCustom;
              delete state._tweaks.iconRev;
              persist(state);
              refreshHeaderAvatar();
              rebuild();
            };
            // dropping a custom icon also drops its engine bytes
            if (icon.iconCustom && state.sessionId) {
              fetch('/api/sessions/' + state.sessionId + '/icon', { method: 'DELETE' })
                .catch(function () {}).then(done, done);
            } else done();
          });
        });
        var iconPick = el.querySelector('#tweaks-icon-pick');
        var iconFile = el.querySelector('#tweaks-icon-file');
        var iconStatus = el.querySelector('#tweaks-icon-status');
        if (iconPick && iconFile) {
          iconPick.addEventListener('click', function () { iconFile.click(); });
          iconFile.addEventListener('change', function () {
            var f = iconFile.files && iconFile.files[0];
            iconFile.value = '';
            if (!f) return;
            if (!window.CropUI) {
              if (iconStatus) iconStatus.textContent = 'the cropper is not available';
              return;
            }
            if (iconStatus) iconStatus.textContent = 'opening the cropper…';
            var go = function () {
              window.CropUI.open({
                file: f,
                aspect: 1,        // SQUARE — the avatar renders as a circle
                maxEdge: 512,
                onDone: function (b64, dims) {
                  var blob = b64ToBlob(b64, 'image/png');
                  if (!blob) {
                    if (iconStatus) iconStatus.textContent = 'couldn\u2019t read that image — try another';
                    return;
                  }
                  if (iconStatus) iconStatus.textContent = 'uploading…';
                  uploadCustomIcon(state, blob).then(function (d) {
                    var rev = (d && d.rev) || 1;
                    icon.setCustomIcon(rev);
                    touch(state);
                    state._tweaks.iconCustom = true;
                    state._tweaks.iconRev = rev;
                    persist(state);
                    refreshHeaderAvatar();
                    rebuild();
                    var ns = cur && cur.panel
                      ? cur.panel.bodyEl.querySelector('#tweaks-icon-status') : null;
                    if (ns) ns.textContent = 'custom icon set — cropped ' +
                      dims.width + '\u00d7' + dims.height + '.';
                  }).catch(function (err) {
                    if (iconStatus) iconStatus.textContent = 'couldn\u2019t set that icon — ' +
                      (err && err.message ? err.message : 'try another');
                  });
                },
                onCancel: function () {
                  if (iconStatus) iconStatus.textContent = 'crop canceled — nothing changed.';
                },
                onErr: function (msg) {
                  if (iconStatus) iconStatus.textContent = msg || 'could not read that image';
                }
              });
            };
            if (state.sessionId) return go();
            if (window.ChatPanel && window.ChatPanel.ensureSession) {
              window.ChatPanel.ensureSession(state, go);
            }
          });
        }
        var iconRm = el.querySelector('#tweaks-icon-remove');
        if (iconRm) iconRm.addEventListener('click', function () {
          var done = function () {
            icon.clearCustomIcon();
            touch(state);
            delete state._tweaks.iconCustom;
            delete state._tweaks.iconRev;
            persist(state);
            refreshHeaderAvatar();
            rebuild();
          };
          if (state.sessionId) {
            fetch('/api/sessions/' + state.sessionId + '/icon', { method: 'DELETE' })
              .catch(function () {}).then(done, done);
          } else done();
        });

        // v0.49 (user spec): the master reset — "reset text sizes and
        // background … to default or inherit from global". One tap
        // drops EVERY per-chat override (colors, sizes, background +
        // the uploaded assets) so the chat follows the global look.
        var resetAllBtn = el.querySelector('#tweaks-reset-all');
        if (resetAllBtn) resetAllBtn.addEventListener('click', function () {
          resetAll(state);
        });

        // v0.44: the Background segment — gradient / image (the color
        // pill merged into the gradient editor: a 1-color spec IS the
        // solid). The zones all exist in the DOM (the v30 pipeline drives
        // them headlessly); the segment just shows one at a time.
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

        // the gradient editor (FULL options — style / pattern / angle /
        // texture) — wire() mutates the spec IN PLACE: live (color /
        // angle) updates the chat + the preview strip in place; shape
        // changes (add/remove/shuffle/random/dir) persist + rebuild the
        // view (preserving expansion + scroll — the wire contract). A
        // freshly picked texture lands in spec.tex as a dataURL FIRST —
        // the rebuild hook intercepts it (uploadTexture → texRev →
        // re-render from the store) before the generic rebuild runs.
        var gr = el.querySelector('#tw-gr');
        if (gr && window.GradientUI) {
          var spec = bgSpecFor(t0);
          window.GradientUI.wire(gr, {
            spec: spec,
            live: function () {
              setBgGradient(state, spec);
              var pv = el.querySelector('#tw-grad-preview');
              if (pv) pv.setAttribute('style', bgPreviewStyle(spec, state));
            },
            rebuild: function () {
              if (spec.tex && typeof spec.tex === 'string' &&
                  String(spec.tex).slice(0, 5) === 'data:') {
                uploadTexture(state, spec);   // upload → texRev → rebuild
                return;
              }
              setBgGradient(state, spec);
              rebuild();
            }
          });
        }

        // the ✕ texture row — the engine row + the persisted texRev go
        // together (an object with an EXPLICIT texRev key is authoritative
        // in setBgGradient, so null clears it)
        var texRm = el.querySelector('#tw-tex-rm');
        if (texRm) texRm.addEventListener('click', function () {
          var done = function () {
            var spec = bgSpecFor(state._tweaks || {});
            spec.texRev = null;
            setBgGradient(state, spec);
            rebuild();
          };
          if (state.sessionId) {
            fetch('/api/sessions/' + state.sessionId + '/texture', { method: 'DELETE' })
              .catch(function () {})
              .then(done, done);
          } else done();
        });

        var pick = el.querySelector('#tweaks-bg-pick');
        var file = el.querySelector('#tweaks-bg-file');
        var status = el.querySelector('#tweaks-bg-status');
        if (pick && file) {
          pick.addEventListener('click', function () { file.click(); });
          file.addEventListener('change', function () {
            var f = file.files && file.files[0];
            file.value = '';
            if (!f) return;
            if (!window.CropUI) {
              if (status) status.textContent = 'the cropper is not available';
              return;
            }
            // v0.44 (user spec): CROP AND FIT before the upload — the
            // frame opens at the LIVE chat-root aspect (what the photo
            // actually fills on screen); the fallback chain is the
            // viewport, then CropUI's own 1.5 default
            var aspect = 1.5;
            try {
              var r = state._chatRootEl && state._chatRootEl.getBoundingClientRect();
              if (r && r.width > 0 && r.height > 0) aspect = r.width / r.height;
              else if (window.innerWidth > 0 && window.innerHeight > 0) {
                aspect = window.innerWidth / window.innerHeight;
              }
            } catch (e) { /* keep the default */ }
            if (status) status.textContent = 'opening the cropper…';
            var go = function () {
              window.CropUI.open({
                file: f,
                aspect: aspect,
                maxEdge: 1600,   // the crop comes from the ORIGINAL pixels
                onDone: function (b64, dims) {
                  // CropUI outputs PNG (raw base64) — a Blob for the PUT
                  var blob = b64ToBlob(b64, 'image/png');
                  if (!blob) {
                    if (status) status.textContent = 'couldn\u2019t read that image — try another';
                    return;
                  }
                  if (status) status.textContent = 'uploading…';
                  uploadBackground(state, blob).then(function () {
                    rebuild();   // the fresh view carries the new status line
                    var ns = cur && cur.panel
                      ? cur.panel.bodyEl.querySelector('#tweaks-bg-status') : null;
                    if (ns) ns.textContent = 'background set — cropped ' +
                      dims.width + '\u00d7' + dims.height + ' at full clarity.';
                  }).catch(function (err) {
                    if (status) status.textContent = 'couldn\u2019t set that image — ' +
                      (err && err.message ? err.message : 'try another');
                  });
                },
                onCancel: function () {
                  if (status) status.textContent = 'crop canceled — nothing changed.';
                },
                onErr: function (msg) {
                  if (status) status.textContent = msg || 'could not read that image';
                }
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
    resetAll: withState(resetAll),
    setBgColor: withState(setBgColor),
    setBgGradient: withState(setBgGradient),
    clearBg: withState(clearBg),
    effective: effective,
    apply: apply
  };
})();
