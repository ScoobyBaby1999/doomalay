// formatter.js — v0.17 the FORMATTING ENGINE.
//
// The user spec: "the output itself is not formatted… We should detect and
// put formatting on the responses as well, and the user inputs too.
// Everything should be formatted… even more formatting or slight colors…
// brighter texts here and there, a simple matching color scheme of 2 or 3
// adjacent colors or different hues."
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
    }
  };

  // Live scheme state — also persisted by Settings (chatScheme + overrides).
  var currentScheme = 'teal';

  function applyScheme(name, overrides) {
    var preset = SCHEMES[name] || SCHEMES.teal;
    var vars = {
      '--fmt-a1': preset.a1,
      '--fmt-a2': preset.a2,
      '--fmt-a3': preset.a3,
      '--fmt-bright': preset.bright,
      '--fmt-link': preset.link
    };
    if (overrides) {
      for (var k in overrides) {
        if (overrides[k]) vars['--fmt-' + k] = overrides[k];
      }
    }
    var root = document.documentElement;
    for (var v in vars) root.style.setProperty(v, vars[v]);
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
      var body = mdToHtml(ex.text);
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
    return { el: el, artifacts: artifacts };
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
      codeEl.className = 'language-' + pl;
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
      if (lang) {
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

    // 4) tables get a wrapper for horizontal scroll on narrow screens
    el.querySelectorAll('table').forEach(function (t) {
      if (t.parentNode.classList && t.parentNode.classList.contains('fmt-tablewrap')) return;
      var wrap = document.createElement('div');
      wrap.className = 'fmt-tablewrap';
      t.parentNode.insertBefore(wrap, t);
      wrap.appendChild(t);
    });
  }

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
    schemes: SCHEMES,
    currentScheme: function () { return currentScheme; },
    copyText: copyText,
    extractArtifacts: extractArtifacts,
    esc: esc
  };

  // Boot with the persisted scheme (Settings may override right after).
  applyScheme('teal');
})();
