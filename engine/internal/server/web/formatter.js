// formatter.js — v0.44 the FORMATTING ENGINE.
//
// The user spec: "the output itself is not formatted… We should detect and
// put formatting on the responses as well, and the user inputs too.
// Everything should be formatted… even more formatting or slight colors…
// brighter texts here and there, a simple matching color scheme of 2 or 3
// adjacent colors or different hues."
//
// v0.44: the 5 scheme slots (a1/a2/a3/bright/link) may each hold a
// GRADIENT SPEC (uikit.js GradientUI) — applyScheme writes the slot's
// var-twin pair + tags :root[data-fmt-grad] so index.html's
// background-clip:text rules can paint gradient TEXT (headings, emphasis,
// strong, links). See the FMT SLOT TWINS block below.
//
// PIPELINE:  raw text
//   → artifact-block extraction (```artifact file=… → artifact cards)
//   → marked (GFM markdown → HTML)
//   → DOMPurify (sanitize; vendored, Apache/MPL)
//   → post-process DOM (link handling, code cards with copy/save buttons,
//     Prism syntax highlighting — vendored MIT)
//   → styled by CSS VARIABLES (the 2–3-hue scheme, user-editable in
//     Settings → Appearance → Chat Colors; every value is a variable).
//
// MODES:
//   full     — assistant replies (markdown + code + links + artifacts)
//   user     — user messages (light markdown; still formatted per spec)
//   thinking — reasoning streams (markdown, dimmed palette + stats)
//   plain    — escaped text w/ line breaks (errors, tool output)
//
// Exposes: window.Formatter
(function () {
  'use strict';

  // ── COLOR SCHEMES (all values are CSS variables) ────────────────
  // Each scheme = 2–3 adjacent hues + shared neutrals. Users can pick a
  // preset OR customize every slot in Settings.
  // v0.24: one scheme per app theme (theme.js pairs them) — including
  // DARK-TEXT schemes for the light themes (paper/frost).
  var SCHEMES = {
    teal: {
      label: 'Teal Nights',
      a1: '#22d3ee', a2: '#2dd4bf', a3: '#38bdf8',
      bright: '#e8fbff', link: '#67e8f9'
    },
    sunset: {
      label: 'Sunset Ember',
      a1: '#fbbf24', a2: '#fb923c', a3: '#f472b6',
      bright: '#fff4e6', link: '#fdba74'
    },
    forest: {
      label: 'Forest Glow',
      a1: '#4ade80', a2: '#34d399', a3: '#2dd4bf',
      bright: '#eafff2', link: '#86efac'
    },
    berry: {
      label: 'Berry Nebula',
      a1: '#c084fc', a2: '#a78bfa', a3: '#f0abfc',
      bright: '#f6effe', link: '#d8b4fe'
    },
    ocean: {
      label: 'Deep Ocean',
      a1: '#38bdf8', a2: '#7dd3fc', a3: '#818cf8',
      bright: '#eaf6ff', link: '#7dd3fc'
    },
    rose: {
      label: 'Rose Quartz',
      a1: '#f472b6', a2: '#fb7185', a3: '#e879f9',
      bright: '#fff0f6', link: '#f9a8d4'
    },
    mono: {
      label: 'Silver Screen',
      a1: '#d4d4d4', a2: '#a8a8a8', a3: '#8a8a8a',
      bright: '#f5f5f5', link: '#c4c4c4'
    },
    solar: {
      label: 'Solar Flare',
      a1: '#fbbf24', a2: '#67e8f9', a3: '#a5b4fc',
      bright: '#fdfdf5', link: '#67e8f9'
    },
    paper: {
      label: 'Ink on Paper',
      a1: '#b45309', a2: '#0e7490', a3: '#be185d',
      bright: '#1c1917', link: '#0e7490'
    },
    frost: {
      label: 'Ink on Frost',
      a1: '#4f6ef7', a2: '#0891b2', a3: '#c026d3',
      bright: '#111827', link: '#0891b2'
    }
  };

  // Live scheme state — also persisted by Settings (chatScheme + overrides).
  var currentScheme = 'teal';

  // ── v0.44 THE FMT SLOT TWINS ──────────────────────────────────────
  // Every slot value (preset hex, legacy hex override, or a gradient
  // SPEC from the appearance editor) resolves into a var-twin pair
  // written on :root:
  //   --fmt-<slot>          the SOLID (first color — every color: rule
  //                          in index.html keeps working)
  //   --fmt-<slot>-gradient the background-image value, or the literal
  //                          'none' when the spec paints solid
  //   --fmt-<slot>-ink      'transparent' ONLY while the slot paints a
  //                          gradient (the background-clip:text rules
  //                          key on it; removed otherwise so the solid
  //                          color: rule paints)
  // PLUS the :root attribute data-fmt-grad = the space-separated list
  // of slots actually painting a gradient (e.g. 'a1 link') — absent
  // when none. index.html's [data-fmt-grad~=…] text-clip rules engage
  // per slot only then. (The per-chat tweaks path can do the same on
  // #chat-root — any ancestor attribute works.) TEXTURE (spec.tex) is
  // stripped: text-clip glyphs can't blend a texture layer sensibly.
  var FMT_SLOTS = ['a1', 'a2', 'a3', 'bright', 'link'];
  function fmtTwins(raw) {
    var G = (typeof window !== 'undefined') ? window.GradientUI : null;
    if (G && G.norm) {
      var spec = G.norm(raw);
      if (spec.tex) delete spec.tex;   // fmt slots never paint texture
      var solid = spec.colors[0];
      var css = G.css(spec);
      return { solid: solid, css: css, grad: (css === solid) ? 'none' : css };
    }
    // no-uikit fallback: a plain string stays the solid; an object
    // degrades to its first color (never a '[object Object]' paint)
    var s = (raw && typeof raw === 'object' && Array.isArray(raw.colors) && raw.colors[0]) ? raw.colors[0] : raw;
    s = String(s == null ? '' : s);
    return { solid: s, css: s, grad: 'none' };
  }

  function applyScheme(name, overrides) {
    var preset = SCHEMES[name] || SCHEMES.teal;
    var root = document.documentElement;
    var gradSlots = [];
    FMT_SLOTS.forEach(function (k) {
      var raw = (overrides && overrides[k]) || preset[k];
      var twins = fmtTwins(raw);
      root.style.setProperty('--fmt-' + k, twins.solid);
      root.style.setProperty('--fmt-' + k + '-gradient', twins.grad);
      if (twins.grad !== 'none') {
        gradSlots.push(k);
        root.style.setProperty('--fmt-' + k + '-ink', 'transparent');
      } else {
        root.style.removeProperty('--fmt-' + k + '-ink');
      }
    });
    if (gradSlots.length) root.setAttribute('data-fmt-grad', gradSlots.join(' '));
    else root.removeAttribute('data-fmt-grad');
    currentScheme = name;
  }

  // ── Artifact block extraction ──────────────────────────────────
  // ```artifact file=name.ext [encoding=base64] ... ``` → placeholder
  // tokens (survive markdown) → replaced with artifact cards after.
  // v0.17 hardening: reasoning models sometimes START a fence then abort
  // mid-line ("```artifact file=trading_notebooks? No. Removeant when…") —
  // the filename must look like a real filename or the block stays a
  // normal code block (never extract garbage).
  var ART_RE = /```artifact[ \t]+([^\n]*)\n([\s\S]*?)```/g;
  var FNAME_RE = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,120}$/;

  function parseArtifactInfo(infoStr) {
    var info = { file: '', encoding: 'utf8' };
    var m = infoStr.match(/file\s*=\s*"?([^"\s]+)"?/i);
    if (m) info.file = m[1];
    m = infoStr.match(/encoding\s*=\s*(base64|utf-?8)/i);
    if (m) info.encoding = /base64/i.test(m[1]) ? 'base64' : 'utf8';
    // a real filename never contains ?, /, control chars, or leading dots
    if (info.file && !FNAME_RE.test(info.file)) info.file = '';
    return info;
  }

  function extractArtifacts(text) {
    var found = [];
    var out = text.replace(ART_RE, function (_all, infoStr, body) {
      var info = parseArtifactInfo(String(infoStr));
      if (!info.file) return _all; // aborted/garbled fence → stays a code block
      var idx = found.push({
        file: info.file,
        encoding: info.encoding,
        content: String(body).replace(/\n$/, '')
      }) - 1;
      return '\n\n%%DOOMALAY-ARTIFACT-' + idx + '%%\n\n';
    });
    return { text: out, artifacts: found };
  }

  function esc(text) {
    var d = document.createElement('div');
    d.textContent = text == null ? '' : String(text);
    return d.innerHTML;
  }

  function escAttr(text) {
    return esc(text).replace(/"/g, '&quot;');
  }

  function humanBytes(n) {
    if (n == null || isNaN(n)) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }

  // ── Marked setup (once) ─────────────────────────────────────────
  function ensureMarked() {
    if (window.marked && !marked._doomalayCfg) {
      try {
        marked.setOptions({ gfm: true, breaks: true, headerIds: false, mangle: false });
        marked._doomalayCfg = true;
      } catch (e) { /* older marked: options via marked.options */ }
    }
  }

  function mdToHtml(text) {
    ensureMarked();
    try {
      if (window.marked && marked.parse) return marked.parse(text);
    } catch (e) { /* fall through */ }
    return '<p>' + esc(text).replace(/\n/g, '<br>') + '</p>';
  }

  function sanitize(html) {
    if (window.DOMPurify) {
      return DOMPurify.sanitize(html, {
        ADD_ATTR: ['target', 'rel', 'class', 'style', 'data-lang', 'data-filename', 'aria-label'],
        ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|data:image\/|\/|#)/i
      });
    }
    return html; // vendored purify failed to load — rare; still escaped inputs
  }

  // ── Code language → Prism language map (fallback: none) ─────────
  function prismLangOf(langLabel, filename) {
    var FT = window.FileTypes || {};
    if (FT.prismLang) {
      var viaFile = filename && FT.prismLang(filename);
      if (viaFile) return viaFile;
      var viaLabel = FT.prismLangFromAlias && FT.prismLangFromAlias(langLabel);
      if (viaLabel) return viaLabel;
    }
    return null;
  }

  // ── The renderer ────────────────────────────────────────────────
  // renderInto(el, text, opts) → { artifacts: [...], el }
  // opts: { mode: 'full'|'user'|'thinking'|'plain', streaming: bool,
  //         thinkingMeta: {elapsed, chars} }
  //
  // v0.22 STREAMING PERF — two rules that killed the UI before:
  //   1. A >4KB code block while streaming is COLLAPSED to its head + a
  //      live byte counter (a streaming .docx base64 fence used to lay
  //      out a 100KB wall of text on EVERY tick — the RTF-generation
  //      freeze the user reported). Full text still renders on final.
  //   2. Prism highlighting is deferred to the final render (highlighting
  //      a growing code block per tick is pure waste — the highlight
  //      would be recomputed anyway).
  function renderInto(el, text, opts) {
    opts = opts || {};
    var mode = opts.mode || 'full';
    text = String(text == null ? '' : text);

    var artifacts = [];
    var html;

    if (mode === 'plain') {
      html = '<div class="fmt fmt-plain">' + esc(text).replace(/\n/g, '<br>') + '</div>';
    } else if (mode === 'user') {
      // light markdown for user input — bold/italic/code/links/linebreaks
      var u = esc(text);
      u = u
        .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|\W)\*([^*\n]+)\*(?=\W|$)/g, '$1<em>$2</em>')
        .replace(/`([^`\n]+)`/g, '<code class="fmt-code-inline">$1</code>')
        .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a class="fmt-link" href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
        .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a class="fmt-link" href="$2" target="_blank" rel="noopener noreferrer">$2</a>')
        .replace(/\n/g, '<br>');
      html = '<div class="fmt fmt-user">' + u + '</div>';
    } else {
      // full + thinking: artifact extraction, then markdown
      var ex = extractArtifacts(text);
      artifacts = ex.artifacts;
      // v0.22: an OPEN artifact fence (```artifact ... no closing ``` yet)
      // renders as a growing code block of raw base64 — collapse it to a
      // compact "building…" note while streaming.
      var bodyText = ex.text;
      if (opts.streaming) {
        bodyText = collapseStreamingFences(bodyText);
      }
      var body = mdToHtml(bodyText);
      if (mode === 'thinking') {
        // dim the thinking palette via the scope class; markdown still works
        body = body.replace(/<(h[1-6])(\s|>)/g, '<$1 class="fmt-th-h"$2');
      }
      var scopeClass = mode === 'thinking' ? 'fmt fmt-thinking' : 'fmt fmt-full';
      html = '<div class="' + scopeClass + '">' + body + '</div>';
    }

    el.innerHTML = sanitize(html);

    // Streaming cursor (appended INSIDE the scope div)
    if (opts.streaming && mode !== 'plain') {
      var scope = el.querySelector('.fmt');
      if (scope) {
        var cur = document.createElement('span');
        cur.className = 'fmt-cursor';
        scope.appendChild(cur);
      }
    }

    // thinking stats line (elapsed + chars — the creative extra)
    if (mode === 'thinking' && opts.thinkingMeta) {
      var tm = opts.thinkingMeta;
      var stats = document.createElement('div');
      stats.className = 'fmt-th-stats';
      stats.textContent = '✻ reasoning · ' + (tm.elapsed || 0) + 's · ' +
        (tm.chars != null ? humanChars(tm.chars) : '');
      el.insertBefore(stats, el.firstChild);
    }

    postProcess(el, artifacts, opts);
    // v0.22 PERF: only the FINAL render pays for Prism + full code layout.
    if (opts.streaming) {
      collapseLongCode(el);
    }
    return { el: el, artifacts: artifacts };
  }

  // v0.22: while streaming, a ```artifact fence that has not closed yet
  // is a raw wall of (often base64) text — replace it with a live status
  // note. Regex mirrors ART_RE's opener.
  function collapseStreamingFences(text) {
    return text.replace(/```artifact[ \t]+([^\n]*)\n[\s\S]*$/g, function (_all, infoStr) {
      var m = String(infoStr).match(/file\s*=\s*"?([^"\s]+)"?/i);
      var fname = m ? m[1] : 'file';
      return '\n```text\n⏳ building ' + fname + ' …\n```\n';
    });
  }

  // v0.22: while streaming (or for huge code), truncate the displayed
  // body of code blocks — the layout cost of a 100KB <pre> is a freeze.
  function collapseLongCode(el) {
    var pres = el.querySelectorAll('pre');
    pres.forEach(function (pre) {
      var codeEl = pre.querySelector('code');
      if (!codeEl) return;
      var t = codeEl.textContent || '';
      if (t.length <= 4000) return;
      var keep = t.slice(0, 2000);
      var note = document.createElement('div');
      note.className = 'fmt-code-trunc';
      note.style.cssText = 'padding:6px 12px;color:var(--text-3);font-size: calc(var(--ui-small-fs) - 1px);border-top:1px dashed var(--border)';
      note.textContent = '… ' + (t.length / 1024).toFixed(1) + ' KB streaming — full text renders when complete';
      codeEl.textContent = keep + '\n';
      if (pre.parentNode) pre.parentNode.insertBefore(note, pre.nextSibling);
    });
  }

  function humanChars(n) {
    if (n == null) return '';
    if (n < 1000) return n + ' chars';
    return (n / 1000).toFixed(1) + 'k chars';
  }

  // ── Prism highlighting with lazy language loading ───────────────
  var prismLoaded = {};
  function highlightWith(codeEl, pl) {
    if (!window.Prism) return;
    var go = function () {
      // v0.34: KEEP .fmt-codetext — the plain assignment wiped the class,
      // so Prism-highlighted code dropped out of the chat-size scaling
      // (the .fmt-codetext CSS only reached un-highlighted blocks).
      codeEl.className = 'fmt-codetext language-' + pl;
      try { Prism.highlightElement(codeEl); } catch (e) {}
    };
    if (Prism.languages[pl]) { go(); return; }
    if (prismLoaded[pl]) { prismLoaded[pl].then(go).catch(function () {}); return; }
    var s = document.createElement('script');
    s.src = '/vendor/format/prism-' + pl + '.min.js';
    prismLoaded[pl] = new Promise(function (res, rej) {
      s.onload = res; s.onerror = rej;
    });
    document.head.appendChild(s);
    prismLoaded[pl].then(go).catch(function () {});
  }

  // ── Post-process the sanitized DOM ──────────────────────────────
  function postProcess(el, artifacts, opts) {
    var mode = opts.mode || 'full';

    // 1) artifact placeholder tokens → artifact cards
    var walker = el.querySelectorAll('.fmt');
    walker.forEach(function (scope) {
      var tokenRe = /%%DOOMALAY-ARTIFACT-(\d+)%%/;
      // tokens appear inside <p> text nodes — walk them
      var p = scope.querySelectorAll('p');
      p.forEach(function (para) {
        var txt = para.textContent;
        var m = txt.match(tokenRe);
        while (m) {
          var idx = parseInt(m[1], 10);
          var card = artifactCard(artifacts[idx]);
          var tmp = document.createElement('div');
          tmp.innerHTML = card;
          var cardEl = tmp.firstChild;
          if (para.textContent.trim() === txt.trim()) {
            // paragraph is ONLY the token → replace the whole <p>
            para.parentNode.replaceChild(cardEl, para);
          } else {
            para.parentNode.insertBefore(cardEl, para.nextSibling);
            para.textContent = txt.replace(tokenRe, '').trim();
            if (!para.textContent) para.parentNode.removeChild(para);
          }
          txt = para.isConnected ? para.textContent : '';
          m = txt ? txt.match(tokenRe) : null;
        }
      });
    });

    // 2) code blocks → code cards (header: lang + copy + save-as-artifact)
    var pres = el.querySelectorAll('pre');
    pres.forEach(function (pre) {
      var codeEl = pre.querySelector('code');
      if (!codeEl) return;
      // language from the class marked produced (language-xxx)
      var lang = '';
      var cls = (codeEl.className || '').match(/language-([\w+#-]+)/);
      if (cls) lang = cls[1];
      var codeText = codeEl.textContent;

      var card = document.createElement('div');
      card.className = 'fmt-codecard';
      var head = document.createElement('div');
      head.className = 'fmt-codehead';
      var tag = document.createElement('span');
      tag.className = 'fmt-codelang';
      tag.textContent = lang || 'text';
      head.appendChild(tag);
      var spacer = document.createElement('span');
      spacer.style.flex = '1';
      head.appendChild(spacer);

      var copyBtn = document.createElement('button');
      copyBtn.className = 'fmt-cbtn';
      copyBtn.textContent = 'copy';
      copyBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        copyText(codeText, function () {
          copyBtn.textContent = 'copied ✓';
          setTimeout(function () { copyBtn.textContent = 'copy'; }, 1400);
        });
      });
      head.appendChild(copyBtn);

      // creative extra: one-tap save any code block as an artifact
      if (mode === 'full' && window.Artifacts) {
        var saveBtn = document.createElement('button');
        saveBtn.className = 'fmt-cbtn fmt-cbtn-save';
        saveBtn.textContent = '⇩ file';
        saveBtn.title = 'Save as artifact';
        saveBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          window.dispatchEvent(new CustomEvent('doomalay:save-code-artifact', {
            detail: { language: lang, code: codeText }
          }));
          saveBtn.textContent = 'saved ✓';
          setTimeout(function () { saveBtn.textContent = '⇩ file'; }, 1400);
        });
        head.appendChild(saveBtn);
      }

      pre.parentNode.replaceChild(card, pre);
      card.appendChild(head);
      // <pre><code> moves inside the card; Prism highlights it
      card.appendChild(pre);
      pre.classList.add('fmt-pre');
      codeEl.classList.add('fmt-codetext');
      // v0.22: no Prism while streaming — the final render highlights.
      if (lang && !opts.streaming) {
        var pl = prismLangOf(lang, '');
        if (pl) {
          highlightWith(codeEl, pl); // lazy-loads the language component
        }
      }
    });

    // 3) links — bright, obviously tappable; external → Chrome via
    //    MainActivity shouldOverrideUrlLoading. Add ↗ cue.
    var links = el.querySelectorAll('a[href]');
    links.forEach(function (a) {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
      if (/^https?:/i.test(a.getAttribute('href') || '')) {
        a.classList.add('fmt-link');
        var cue = document.createElement('span');
        cue.className = 'fmt-link-cue';
        cue.textContent = ' ↗';
        a.appendChild(cue);
      }
    });

    // 3.5) v0.28 MEDIA EMBEDS (user spec: images / YouTube / links that
    // are clickable, expandable, zoomable, redirectable). Research call:
    // no third-party lightbox is worth vendoring — the WebView already
    // has everything. Images render natively (marked → <img>, DOMPurify
    // keeps them, the engine sends no CSP) and get a pinch-zoom overlay;
    // YouTube links become 16:9 thumbnail player cards (thumbnail CDN is
    // keyless) that redirect to the real player; other links keep the
    // inline + ↗ shape.
    if (mode === 'full' || mode === 'user') {
      embedMedia(el, mode);
    }

    // 4) tables get a wrapper for horizontal scroll on narrow screens
    el.querySelectorAll('table').forEach(function (t) {
      if (t.parentNode.classList && t.parentNode.classList.contains('fmt-tablewrap')) return;
      var wrap = document.createElement('div');
      wrap.className = 'fmt-tablewrap';
      t.parentNode.insertBefore(wrap, t);
      wrap.appendChild(t);
    });
  }

  // ── v0.28 media embed pass ──────────────────────────────────────
  var YT_RE = /^(?:https?:)?\/\/(?:www\.|m\.)?youtube\.com\/(?:watch\?[^#]*v=|shorts\/|embed\/|live\/)([\w-]{6,})|^https?:\/\/youtu\.be\/([\w-]{6,})/i;

  function embedMedia(el, mode) {
    // images: cap size + wire the zoom overlay
    el.querySelectorAll('img').forEach(function (img) {
      if (img.classList.contains('fmt-yt-thumbimg')) return; // YouTube card art
      img.classList.add('fmt-media-img');
      img.setAttribute('loading', 'lazy');
      img.setAttribute('decoding', 'async');
      img.setAttribute('referrerpolicy', 'no-referrer');
      img.addEventListener('click', function (e) {
        e.preventDefault();
        window.MediaZoom.open(img.currentSrc || img.src, img.alt || '');
      });
    });

    // YouTube links → thumbnail player cards
    el.querySelectorAll('a[href]').forEach(function (a) {
      var href = a.getAttribute('href') || '';
      var m = href.match(YT_RE);
      if (!m) return;
      var vid = m[1] || m[2];
      if (!vid) return;
      var card = document.createElement('div');
      card.className = 'fmt-yt';
      card.setAttribute('data-href', href);
      var label = (a.textContent || '').replace(/\s*↗\s*$/, '').trim();
      card.innerHTML =
        '<div class="fmt-yt-thumb">' +
          '<img class="fmt-yt-thumbimg" src="https://i.ytimg.com/vi/' + esc(vid) + '/hqdefault.jpg" loading="lazy" decoding="async" referrerpolicy="no-referrer" alt="">' +
          '<span class="fmt-yt-play">▶</span>' +
        '</div>' +
        '<div class="fmt-yt-cap">' + esc(label && label !== href ? label : 'YouTube · ' + vid) +
          '<span class="fmt-yt-open"> ↗</span></div>';
      card.addEventListener('click', function () {
        try { window.open(href, '_blank'); } catch (e) { location.href = href; }
      });
      // a link sitting alone in its <p> → the card replaces the <p>;
      // otherwise it slots in right after
      var p = a.closest('p') || a.parentNode;
      if (p && p.textContent.trim() === (a.textContent || '').trim() && p.tagName === 'P') {
        p.parentNode.replaceChild(card, p);
      } else {
        a.parentNode.insertBefore(card, a.nextSibling);
        if (!(a.textContent || '').replace(/↗/, '').trim()) a.remove();
        else { a.classList.add('fmt-link-kept'); }
      }
    });
  }

  // ── v0.28 MediaZoom — the pinch-zoom image overlay ────────────────
  // One fullscreen layer per app: scrim + img + open-external ✕ close.
  // Pointer events: 1 pointer pans, 2 pinch-zoom, double-tap resets.
  // Zero dependencies; ~90 lines. Attached lazily on first open.
  var MediaZoom = (function () {
    var root = null, img = null, tx = 0, ty = 0, scale = 1;
    var pointers = {}, lastDist = 0, lastTap = 0;

    function ensure() {
      if (root) return;
      root = document.createElement('div');
      root.id = 'media-zoom';
      root.innerHTML =
        '<button id="mz-open" aria-label="open externally">↗ open</button>' +
        '<button id="mz-close" aria-label="close">✕</button>' +
        '<img id="mz-img" alt="">';
      document.body.appendChild(root);
      img = root.querySelector('#mz-img');
      root.addEventListener('click', function (e) {
        if (e.target === root || e.target === img) close();
      });
      root.querySelector('#mz-close').addEventListener('click', close);

      // pointer bookkeeping
      root.addEventListener('pointerdown', function (e) {
        pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
        if (count() === 1) {
          var now = Date.now();
          if (now - lastTap < 300) { tx = 0; ty = 0; scale = 1; apply(); }
          lastTap = now;
        } else if (count() === 2) {
          lastDist = dist();
        }
        root.setPointerCapture && root.setPointerCapture(e.pointerId);
      });
      root.addEventListener('pointermove', function (e) {
        if (!pointers[e.pointerId]) return;
        if (count() === 1) {
          tx += e.clientX - pointers[e.pointerId].x;
          ty += e.clientY - pointers[e.pointerId].y;
          pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
          apply();
        } else if (count() === 2) {
          pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
          var d = dist();
          if (lastDist > 0 && d > 0) {
            scale = Math.max(0.3, Math.min(12, scale * (d / lastDist)));
            apply();
          }
          lastDist = d;
        }
      });
      function end(e) {
        delete pointers[e.pointerId];
        lastDist = 0;
      }
      root.addEventListener('pointerup', end);
      root.addEventListener('pointercancel', end);
    }
    function count() { return Object.keys(pointers).length; }
    function dist() {
      var ks = Object.keys(pointers);
      if (ks.length < 2) return 0;
      var a = pointers[ks[0]], b = pointers[ks[1]];
      return Math.hypot(a.x - b.x, a.y - b.y);
    }
    function apply() {
      img.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + scale + ')';
    }

    function open(src, alt) {
      ensure();
      tx = 0; ty = 0; scale = 1;
      img.src = src;
      img.alt = alt || '';
      img.style.transform = '';
      var ob = root.querySelector('#mz-open');
      ob.style.display = /^https?:/i.test(src) ? '' : 'none';
      ob.onclick = function () { try { window.open(src, '_blank'); } catch (e) {} };
      root.classList.add('open');
      document.addEventListener('keydown', onKey);
    }
    function onKey(e) { if (e.key === 'Escape') close(); }
    function close() {
      if (!root) return;
      root.classList.remove('open');
      img.src = '';
      document.removeEventListener('keydown', onKey);
    }
    return { open: open, close: close };
  })();

  // ── Artifact card (the "file attached at the end of the message") ─
  function artifactCard(art) {
    if (!art) return '<div class="fmt-artifact"></div>';
    var FT = window.FileTypes || {};
    var meta = FT.info ? FT.info(art.file) : {};
    var icon = meta.icon || '📄';
    var color = meta.color || 'var(--fmt-a2)';
    var size = art.encoding === 'base64'
      ? humanBytes(Math.floor(art.content.length * 3 / 4))
      : humanBytes(art.content.length);
    return (
      '<div class="fmt-artifact" data-artifact-file="' + escAttr(art.file) + '" ' +
        'data-artifact-encoding="' + escAttr(art.encoding) + '">' +
        '<span class="fmt-artifact-ico" style="color:' + color + '">' + icon + '</span>' +
        '<span class="fmt-artifact-meta">' +
          '<span class="fmt-artifact-name">' + esc(art.file) + '</span>' +
          '<span class="fmt-artifact-sub">' + esc(meta.label || 'file') + ' · ' + size + ' · tap to open</span>' +
        '</span>' +
        '<button class="fmt-artifact-dl" data-artifact-dl="1">⇩</button>' +
      '</div>');
  }

  function copyText(text, cb) {
    var done = function () { if (cb) cb(); };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, function () { legacyCopy(text); done(); });
        return;
      }
    } catch (e) {}
    legacyCopy(text); done();
  }
  function legacyCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px;top:0';
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    try { document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(ta);
  }

  // ── Public API ──────────────────────────────────────────────────
  window.Formatter = {
    renderInto: renderInto,
    applyScheme: applyScheme,
    fmtTwins: fmtTwins,   // v0.44: tweaks.js paints the SAME twins on #chat-root
    schemes: SCHEMES,
    currentScheme: function () { return currentScheme; },
    copyText: copyText,
    extractArtifacts: extractArtifacts,
    esc: esc
  };
  // v0.28: media zoom overlay (formatter-internal, but exposed so the
  // artifacts editor / anywhere else can reuse it).
  window.MediaZoom = MediaZoom;

  // Boot with the right scheme: theme pairing (theme.js loads earlier and
  // exposes pendingScheme) → persisted Settings → teal. v0.24 fix: the old
  // hardcoded applyScheme('teal') stomped the user's persisted scheme on
  // every reload (appearance.js registers its onChange BEFORE formatter
  // loads, so the only apply that ran was this one).
  (function () {
    var scheme = 'teal', overrides = null;
    if (window.DoomTheme && window.DoomTheme.pendingScheme) {
      scheme = window.DoomTheme.pendingScheme();
    }
    var s = window.Settings && window.Settings.getState();
    if (s) {
      overrides = s.fmtOverrides || null;
      if (!window.DoomTheme) scheme = s.chatScheme || scheme;
    }
    applyScheme(scheme, overrides);
  })();
})();
