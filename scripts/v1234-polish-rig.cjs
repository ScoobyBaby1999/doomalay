#!/usr/bin/env node
// v1234-polish-rig.cjs — v1.23.4 THE POLISH (PLAN-V123 §4).
//
// The full-view overlay's redesign, pinned:
//   · the head sub derivation (the derived label + tail, glance-sized)
//   · THE ONE BOX (tv-row dies, tv-body is the only surface)
//   · the footer copy (⧉ icon + small label — clear of the static ✕)
//   · the edge room (20px around + the head's ✕-clearance right pad)
//   · the live wire (tvLive payload identity, the 400ms throttle, the
//     tail follow, the result-landing re-render, the onClose kill, the
//     four call sites)
//   · the CSS contract (theme vars only — zero hex in the block)
'use strict';
const fs = require('fs');
const path = require('path');
const WEB = path.join(__dirname, '..', 'engine', 'internal', 'server', 'web');

// ── the stub browser surface (the v1232 rig's pattern) ──────────────
const sandboxLS = {};
global.localStorage = {
  getItem: (k) => Object.prototype.hasOwnProperty.call(sandboxLS, k) ? sandboxLS[k] : null,
  setItem: (k, v) => { sandboxLS[k] = String(v); },
  removeItem: (k) => { delete sandboxLS[k]; }
};
global.window = {
  ChatTypes: { helpers: { SANDBOX_LABELS: {}, SANDBOX_ICONS: {} } },
  addEventListener: function () {}
};
global.document = { addEventListener: function () {}, createElement: () => ({ style: {} }) };
global.location = { protocol: 'http:', host: 'test' };
function FakeWS() {}
FakeWS.prototype.send = function () {};
global.WebSocket = FakeWS;

const P = require(path.join(WEB, 'chatpanel.js'));
const cpSrc = fs.readFileSync(path.join(WEB, 'chatpanel.js'), 'utf8');
const css = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');

let n = 0;
const fails = [];
function ok(name, cond, extra) {
  n++;
  if (!cond) fails.push(name + (extra ? ' — ' + String(extra).slice(0, 300) : ''));
}
function eq(name, got, want) {
  n++;
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    fails.push(name + ' — got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want));
  }
}

// ══ 1. THE HEAD SUB (the derived label, glance-sized) ═══════════════
// Pure seam: tvSubFor(msg, name).
const S = (payload, name) => P.tvSubFor({ payload }, name || (payload && payload.name) || 'tool');

eq('termux exec → sub is label + tail',
  S({ name: 'termux', args: { action: 'exec', args: { command: 'python -m pip install numpy' } } }, 'termux'),
  'python -m pip install numpy');
eq('label === name with a tail → the sub is the tail only (no echo)',
  S({ name: 'termux', args: { action: 'exec', args: { command: 'termux bash -c "ls"' } } }, 'termux'),
  'bash -c "ls"');
eq('a web_search summary sub',
  S({ name: 'web_search', summary: 'best keyboards 2026' }, 'web_search'),
  'best keyboards 2026');
eq('label === name with no tail → empty sub',
  S({ name: 'workspace' }, 'workspace'), '');
eq('garbage args → the name IS the label → empty sub (the name already shows)',
  S({ name: 'termux', args: 'not json' }, 'termux'), '');
// the truncation: a 200-char tail clamps at 90 + the ellipsis
{
  const long = 'x'.repeat(200);
  const got = S({ name: 'termux', args: { action: 'exec', args: { command: 'python ' + long } } }, 'termux');
  eq('the sub clamps at 90 + …', [got.length, got.slice(-1)], [91, '…']);
}

// ══ 2. THE ONE BOX (the two prototype surfaces die) ═════════════════
ok('the ONE body surface rides the markup',
  /'<div class="tv-body">' \+/.test(cpSrc), 'the tv-body element');
ok('tv-row is DEAD in the markup',
  !/tv-row/.test(cpSrc), 'no tv-row anywhere in chatpanel');
ok('the tv-row CSS is dead',
  !/\.tv-row\s*{/.test(css), 'no tv-row rule in index.html');
ok('the tv-q pre rides INSIDE the one box (a tv-sec, not its own box)',
  /'<div class="tv-sec tv-sec-q"><div class="tv-k">query<\/div>'/.test(cpSrc),
  'the query section markup');
ok('the query pre has NO own box CSS (the one-body law)',
  !/\.tv-q\s*{[^}]*background/.test(css) && !/\.tv-q\s*{[^}]*border/.test(css),
  'tv-q carries no background/border');
ok('the result has NO own box CSS either',
  !/\.tv-result\s*{[^}]*background/.test(css) && !/\.tv-result\s*{[^}]*border/.test(css),
  'tv-result carries no background/border');
ok('the ONE divider between sections',
  /\.tv-sec \+ \.tv-sec \{ border-top: 1px solid var\(--border\); \}/.test(css),
  'the tv-sec divider rule');

// the head: icon + name + sub — NO copy button (the ✕ overlap dies)
ok('the head carries the title column (name + sub)',
  cpSrc.indexOf('\'<span class="tv-title">\'') > -1, 'the tv-title span');
ok('the old in-head copy markup is DEAD',
  !/tv-copy" id="' \+ uid \+ '-copy">copy<\/button><\/div>/.test(cpSrc),
  'the one-line head+copy concat is gone');
ok('the copy button only exists in the foot (after the foot div opens)',
  cpSrc.indexOf('<button class="tv-copy"') > cpSrc.indexOf('\'<div class="tv-foot">\''),
  'the foot ordering');

// ══ 3. THE FOOTER COPY (⧉ icon + the small label) ═══════════════════
ok('the footer row exists in the markup',
  cpSrc.indexOf('\'<div class="tv-foot">\'') > -1, 'tv-foot');
ok('the copy button carries the icon span + the label span',
  /tv-copy-ico[^"]*" aria-hidden="true">⧉/.test(cpSrc) && /-copylbl">copy</.test(cpSrc),
  'the ⧉ icon + the copy label');
ok('the "copied" feedback targets the LABEL span (the icon stays)',
  /lbl\.textContent = 'copied'/.test(cpSrc), 'the label span flips');
ok('the copy prefers the repo idiom (Formatter.copyText — the execCommand fallback)',
  /window\.Formatter && window\.Formatter\.copyText\) window\.Formatter\.copyText\(cpText, done\)/.test(cpSrc),
  'the Formatter.copyText branch');
ok('pending → the copy takes the LIVE stream (what is shown is what is copied)',
  /var cpText = pending \? String\(msg\.streamText \|\| ''\) : text;/.test(cpSrc),
  'the pending copy source');

// ══ 4. THE EDGE ROOM (the user's ask: space between edges + elements) ═══
ok('the container carries 20px side padding',
  /\.tool-fullview\s*{[^}]*padding: 20px 20px 16px;/.test(css), 'the padding rule');
ok('the head right pad keeps the ✕ zone clear (≥ 28px by construction)',
  /\.tv-head\s*{[^}]*padding: 2px 34px 2px 0;/.test(css), 'the head clearance');

// ══ 5. THE LIVE WIRE (the open overlay streams + re-renders) ════════
ok('the tracker is payload-identity keyed (reindex-proof)',
  /msg\.payload !== tvLive\.payload/.test(cpSrc), 'the identity guard');
ok('the tick throttles at 400ms (~2 paints/sec — the chunk cadence)',
  /if \(now - tvLive\.lastPaint < 400\) return;/.test(cpSrc), 'the throttle');
ok('the stream area follows the tail (the terminal law)',
  /el\.scrollTop = el\.scrollHeight;/.test(cpSrc), 'the tail follow');
ok('the stream area shows the last 4KB',
  /st\.slice\(-4096\)/.test(cpSrc), 'the 4KB window');
ok('the byte counter rides the tick',
  /tvLive\.uid \+ '-kb'/.test(cpSrc), 'the kb element');
ok('the result landing re-renders the whole view once',
  /tvLive = null;\s*\\n\s*openToolFullView\(state, mi\);/.test(cpSrc) ||
  cpSrc.indexOf('openToolFullView(state, mi); // in place') > -1,
  'the landing re-render');
ok('the overlay close kills the tracker',
  /onClose: function \(\) \{ tvLive = null; \}/.test(cpSrc), 'the onClose kill');
ok('a dead element lookup kills the tracker (closed/replaced)',
  /if \(!el\) \{ tvLive = null; return; \}/.test(cpSrc), 'the dead-element guard');
ok('pending opens track, landed opens do not',
  /tvLive = pending \? \{ payload: pay, uid: uid, landed: false, lastPaint: Date\.now\(\) \} : null;/.test(cpSrc),
  'the track-on-open');
ok('no page host mounts while pending (the landing mounts it)',
  /if \(!pending\) mountPage\(0\);/.test(cpSrc), 'the pending mount guard');

// the pending markup: the live stream trio
ok('the pending trio renders (stream pre + kb + bar)',
  /tv-stream" id="\' \+ uid \+ \'-live"/.test(cpSrc) && /tv-kb" id="\' \+ uid \+ \'-kb"/.test(cpSrc) &&
  /tool-pill-bar tv-bar/.test(cpSrc), 'the pending markup');
ok('the output label names the live state',
  /\(pending \? ' · live' : ''\)/.test(cpSrc), 'the · live label');

// the four call sites (2 stream ticks + 2 landings)
{
  const ticks = (cpSrc.match(/tvStreamTick\(sMsg\);/g) || []).length;
  const lands = (cpSrc.match(/tvResultLanded\(state, (pmTvMi|tvMi), (merged|mergedMsg)\);/g) || []).length;
  eq('the WS + PM stream ticks both fire (2 sites)', ticks, 2);
  eq('the WS + PM result landings both fire (2 sites)', lands, 2);
}

// ══ 5b. THE REPLAY-TAG SEQ LAW (the E2E redteam conviction) ══════════
// The live-stream death the browser walk found: a turn that starts soon
// after the WS connect chains <1200ms arrivals into a permanent "replay"
// tag — the panel's tool_stream guard (ev._replay) killed every live
// chunk (the engine emitted them, the browser received them, the pill
// never moved). The law: only seq-carrying events (persisted, actually
// replayable) can ever be tagged; the ephemeral family (tool_stream,
// progress) is never persisted and never a replay.
const ccSrc = fs.readFileSync(path.join(WEB, 'chatclient.js'), 'utf8');
ok('chatclient: the replay tag requires a seq (ephemeral events never tagged)',
  /ev\.seq !== undefined\) ev\._replay = true;/.test(ccSrc), 'the seq guard');
{
  // behavior: the ephemeral family rides the tagged burst LIVE
  const wsInstances = [];
  function FakeWS2(url) { this.url = url; this.readyState = 1; this.sent = []; wsInstances.push(this); }
  FakeWS2.CONNECTING = 0; FakeWS2.OPEN = 1; FakeWS2.CLOSING = 2; FakeWS2.CLOSED = 3;
  FakeWS2.prototype.send = function () {};
  const savedWS = global.WebSocket;
  const savedWin = global.window;
  global.WebSocket = FakeWS2;
  global.window = { addEventListener: function () {} };
  const ccPath = path.join(WEB, 'chatclient.js');
  delete require.cache[require.resolve(ccPath)];
  require(ccPath); // sets window.ChatClient on the stub
  const CC = global.window.ChatClient;
  global.window = savedWin;
  global.WebSocket = savedWS;
  const client = new CC('s1');
  global.WebSocket = FakeWS2;   // stay patched through the connect + drives
  client.connect();
  const sock = wsInstances[0];
  sock.onopen();
  const seen = [];
  client.onEvent = function (ev) { seen.push(ev); };
  const deliver = (obj) => sock.onmessage({ data: JSON.stringify(obj) });
  deliver({ type: 'assistant_delta', text: 'a', i: 1, seq: 1 });
  deliver({ type: 'tool_stream', name: 'termux', delta: 'x' });
  deliver({ type: 'progress', text: 'y' });
  deliver({ type: 'status', state: 'running' });
  global.window = savedWin;
  global.WebSocket = savedWS;
  ok('chatclient behavior: the seq\'d burst event stays tagged (the replay contract holds)',
    seen[0] && seen[0]._replay === true);
  ok('chatclient behavior: tool_stream during the burst is NEVER tagged (the live-stream fix)',
    seen[1] && seen[1]._replay === undefined, JSON.stringify(seen[1] || null));
  ok('chatclient behavior: progress during the burst is never tagged',
    seen[2] && seen[2]._replay === undefined);
  ok('chatclient behavior: the tagless status event rides live too',
    seen[3] && seen[3]._replay === undefined);
}

// ══ 6. THE CSS CONTRACT (theme vars only) ═══════════════════════════
const blockStart = css.indexOf('.tool-fullview {');
const blockEnd = css.indexOf('/* ── sources cards', blockStart);
const tvBlock = css.slice(blockStart, blockEnd);
ok('the tv block exists', blockStart > -1 && blockEnd > blockStart);
ok('the ONE box paints surface-2 + border + radius',
  /\.tv-body\s*{[^}]*var\(--surface-2\)/.test(tvBlock) && /\.tv-body\s*{[^}]*var\(--border\)/.test(tvBlock) &&
  /border-radius: 14px/.test(tvBlock), 'the tv-body box rule');
ok('the footer row is right-aligned',
  /\.tv-foot\s*{[^}]*justify-content: flex-end/.test(tvBlock), 'the foot rule');
ok('the copy button is icon+label (inline-flex, 6px gap)',
  /\.tv-copy\s*{[^}]*display: inline-flex;[^}]*gap: 6px/.test(tvBlock), 'the copy layout');
ok('the copy icon class exists',
  /\.tv-copy-ico\s*{/.test(tvBlock), 'the icon rule');
ok('the live styles exist (stream + kb + bar)',
  /\.tv-stream\s*{/.test(tvBlock) && /\.tv-kb\s*{/.test(tvBlock) && /\.tv-bar\s*{[^}]*var\(--border\)/.test(tvBlock),
  'the live trio rules');
ok('zero hardcoded hex in the whole tv block',
  !/--#[0-9a-fA-F]{3,8}/.test(tvBlock) && !/: ?#[0-9a-fA-F]{3,8}[,; )]/.test(tvBlock),
  'the theme law');
ok('the merged-result read survived the rewrite (the v1232 pin)',
  /msg\.res !== undefined \? msg\.res :/.test(cpSrc), 'the merged read');

// the exports seam
ok('tvSubFor is exported for this rig',
  /tvSubFor: tvSubFor,/.test(cpSrc), 'the export');

// ══ report ═════════════════════════════════════════════════════════
const byes = fails.length ? '\n  FAIL - ' + fails.join('\n  FAIL - ') : '';
console.log(`v1234 polish rig: ${n - fails.length}/${n}${byes}`);
process.exit(fails.length ? 1 : 0);
