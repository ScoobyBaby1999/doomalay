// formatter.worker.js — v1.32.1 THE OFF-THREAD TAIL (PLAN-V133 §1).
//
// The deferred worker formatter, with THE DOMPURIFY DECISION on the record:
// DOMPurify is DOM-only (upstream issue #577) — running it here would need a
// linkedom/jsdom shim, a new vendored dependency inside the security-
// critical component. So the split is by TRUST and COST:
//
//   WORKER (this file)  — the expensive STRING half: artifact extraction,
//                         streaming-fence collapse, marked.parse. The output
//                         is RAW marked HTML at exactly today's pre-sanitize
//                         trust level. It never touches a DOM.
//   MAIN (formatter.js) — the cheap TRUST half: DOMPurify.sanitize →
//                         innerHTML → postProcess (cards, links, Prism).
//                         ALWAYS. No apply path exists that skips it.
//
// marked is officially worker-safe (the markedjs docs say "you can run
// marked on a worker"); the vendored UMD attaches to globalThis here.
//
// THE PARITY LAW: this file's copies of extractArtifacts /
// collapseStreamingFences / mdToHtml must produce byte-identical output to
// formatter.js's — the v1321 rig pins it on a live corpus. Change them
// together or not at all.
//
// Protocol: {id, mode:'full'|'thinking', text, streaming} →
//           {id, ok:true, html, artifacts} | {id, ok:false, err}
'use strict';

importScripts('/vendor/format/marked.min.js');

// ── marked setup — the SAME options as formatter.js ensureMarked ──
if (self.marked && marked.parse && !marked._doomalayCfg) {
  try {
    marked.setOptions({ gfm: true, breaks: true, headerIds: false, mangle: false });
    marked._doomalayCfg = true;
  } catch (e) { /* older marked: defaults hold */ }
}

// pure-string esc (the main thread's esc uses a DOM element — none here;
// only reached if marked failed to load, in which case main falls back
// to the sync pipeline anyway).
function escP(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── artifact extraction — the formatter.js copy (CHANGE TOGETHER) ──
var ART_RE = /```artifact[ \t]+([^\n]*)\n([\s\S]*?)```/g;
var FNAME_RE = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,120}$/;

function parseArtifactInfo(infoStr) {
  var info = { file: '', encoding: 'utf8' };
  var m = infoStr.match(/file\s*=\s*"?([^"\s]+)"?/i);
  if (m) info.file = m[1];
  m = infoStr.match(/encoding\s*=\s*(base64|utf-?8)/i);
  if (m) info.encoding = /base64/i.test(m[1]) ? 'base64' : 'utf8';
  if (info.file && !FNAME_RE.test(info.file)) info.file = '';
  return info;
}

function extractArtifacts(text) {
  var found = [];
  var out = text.replace(ART_RE, function (_all, infoStr, body) {
    var info = parseArtifactInfo(String(infoStr));
    if (!info.file) return _all;
    var idx = found.push({
      file: info.file,
      encoding: info.encoding,
      content: String(body).replace(/\n$/, '')
    }) - 1;
    return '\n\n%%DOOMALAY-ARTIFACT-' + idx + '%%\n\n';
  });
  // the v0.95.4 unclosed-fence salvage — the same shape as main
  if (found.length === 0) {
    var m = /```artifact[ \t]+([^\n]*)\n([\s\S]*)$/.exec(text);
    if (m) {
      var info = parseArtifactInfo(String(m[1]));
      var partial = String(m[2]).replace(/\n+$/, '');
      if (info.file && partial.trim()) {
        found.push({
          file: info.file,
          encoding: info.encoding,
          content: partial + '\n\n<!-- TRUNCATED: the provider cut this output before the artifact closed — ask the model to continue or re-send the file -->',
          truncated: true
        });
        out = text.slice(0, m.index) + '\n\n%%DOOMALAY-ARTIFACT-0%%\n\n';
      }
    }
  }
  return { text: out, artifacts: found };
}

// ── the v0.22 streaming-fence collapse — the formatter.js copy ──
function collapseStreamingFences(text) {
  return text.replace(/```artifact[ \t]+([^\n]*)\n[\s\S]*$/g, function (_all, infoStr) {
    var m = String(infoStr).match(/file\s*=\s*"?([^"\s]+)"?/i);
    var fname = m ? m[1] : 'file';
    return '\n```text\n⏳ building ' + fname + ' …\n```\n';
  });
}

function mdToHtml(text) {
  try {
    if (self.marked && marked.parse) return marked.parse(text);
  } catch (e) { /* fall through */ }
  return '<p>' + escP(text).replace(/\n/g, '<br>') + '</p>';
}

// ── the job ─────────────────────────────────────────────────────
// The exact shape of formatter.js renderIntoMeasured's full/thinking
// branch: extract → (streaming? collapse) → marked → (thinking? the
// h-class dim) → the scope wrapper. The client sanitizes + writes.
self.onmessage = function (ev) {
  var job = ev.data || {};
  var id = job.id;
  try {
    var mode = job.mode === 'thinking' ? 'thinking' : 'full';
    var text = String(job.text == null ? '' : job.text);

    var ex = extractArtifacts(text);
    var artifacts = ex.artifacts;
    var bodyText = ex.text;
    if (job.streaming) bodyText = collapseStreamingFences(bodyText);

    var body = mdToHtml(bodyText);
    if (mode === 'thinking') {
      body = body.replace(/<(h[1-6])(\s|>)/g, '<$1 class="fmt-th-h"$2');
    }
    var scopeClass = mode === 'thinking' ? 'fmt fmt-thinking' : 'fmt fmt-full';
    var html = '<div class="' + scopeClass + '">' + body + '</div>';

    self.postMessage({ id: id, ok: true, html: html, artifacts: artifacts });
  } catch (e) {
    self.postMessage({ id: id, ok: false, err: String(e && e.message || e) });
  }
};
