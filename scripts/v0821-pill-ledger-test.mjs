// v0821-pill-ledger-test.mjs — THE PILL LEDGER (user task, verbatim:
//   "while we do give the chat a lot of context in terms of what each
//    setting in the chat metadata does, the chat doesn't know about it,
//    let's have the chat know it has a metadata with tweak-able settings
//    and all the pills, since it already knows everything within the
//    metadata" — with the live repro: asked "What does the workspaces
//    pill do?", the bot answered "I don't have any information about a
//    workspaces pill … it isn't described in my instructions").
//
// THE PILL LEDGER: both metadata-block twins (the engine's
// chatMetadataPreamble + the PM client's pmMetadataBlock) now name EVERY
// pill the chat UI renders — the workspaces +workspace badge, the bundle
// pill right of the lib pill, the mind pill — with live values, plus the
// answer-from-this-block rule. This rig pins the PM twin (slice the
// SHIPPING functions out of chatpanel.js — the v0781 pattern); the
// engine twin is pinned by its own Go test (server package).
//
// Run: node scripts/v0821-pill-ledger-test.mjs   (from the repo root)
import { readFileSync } from 'node:fs';

const src = readFileSync('engine/internal/server/web/chatpanel.js', 'utf8');

function sliceFrom(marker, endMarker) {
  const a = src.indexOf(marker);
  if (a < 0) throw new Error('marker not found: ' + marker);
  const b = src.indexOf(endMarker, a);
  if (b < 0) throw new Error('end marker not found: ' + endMarker);
  return src.slice(a, b);
}

const metaBlock = sliceFrom('function pmMetadataBlock(state)', 'function pmLibraryPreamble(state)');
const mod = new Function(metaBlock + '\n' +
  'return { pmMetadataBlock };');

let PASS = 0, FAIL = 0;
const ok = (name, cond, detail) => {
  if (cond) { PASS++; console.log('PASS: ' + name); }
  else { FAIL++; console.log('FAIL: ' + name + (detail ? ' — ' + detail : '')); }
};

const { pmMetadataBlock } = mod();

// 1. THE LIVE REPRO SHAPE — a chat with a bound workspace + an armed
//    bundle: the block names the workspaces pill, the bundle pill, the
//    mind pill — with their LIVE values — and the answer-from-this-block
//    rule. The bot can never again say "it isn't described in my
//    instructions".
const rich = pmMetadataBlock({
  effort: 'high',
  deepResearch: false,
  libAuto: true, templateAuto: true, skillsAuto: true,
  _tweaks: { botLib: true, botDL: true },
  slidingWindow: 40,
  _pmConn: {
    hf: 'ScoobyBaby1999', gh: 'ScoobyBaby1999', gitea: null,
    bound: [
      { kind: 'github', name: 'ScoobyBaby1999/doomalay-ws-write-test', owner: 'ScoobyBaby1999', repo: 'doomalay-ws-write-test', access: 'full' }
    ],
    totalWorkspaces: 2
  },
  bundle: { name: 'superpowers-core', members: [{ type: 'skill', name: 'tdd' }, { type: 'doc', name: 'verify' }] }
});
ok('the workspaces pill is named (the +workspace badge)',
   rich.includes('workspaces (the +workspace badge on the toolbar'), rich.slice(0, 400));
ok('the workspaces pill carries the LIVE bound repo + access',
   rich.includes('currently 1 (github ScoobyBaby1999/doomalay-ws-write-test (full))'), rich);
ok('the bundle pill is named (right of the lib pill) with its live arm',
   rich.includes('bundle (the small pill immediately right of the lib pill)') &&
   rich.includes('currently armed: "superpowers-core" (2 member(s))'), rich);
ok('the mind pill line names the pill',
   rich.includes('context (the mind pill + \u2726 tweaks \u2192 mind): the last 40 messages'), rich);
ok('the answer-from-this-block rule rides the block',
   rich.includes('answer from THIS block') && rich.includes('Never claim a pill wasn\u2019t described to you.'), rich);
ok('the previously-documented pills survive (effort / lib / dl / template / tweaks)',
   rich.includes('effort (toolbar pill, currently "high")') &&
   rich.includes('Bot Library (the \ud83e\uddf0 lib toolbar pill') &&
   rich.includes('Can download bundles') &&
   rich.includes('active template') &&
   rich.includes('\u2726 tweaks (the header pill)'), rich);

// 2. THE BARE CHAT — no bound workspace, no bundle: the pills are still
//    all named, with honest none-yet state (the user's very first
//    question in the log was asked from this shape).
const bare = pmMetadataBlock({
  effort: 'med',
  _tweaks: {},
  _pmConn: { bound: [], totalWorkspaces: 0 },
  bundle: null
});
ok('bare chat: the workspaces pill still named, honestly empty',
   bare.includes('workspaces (the +workspace badge on the toolbar') &&
   bare.includes('NO repo is bound to this chat yet'), bare);
ok('bare chat: the bundle pill still named, none-yet shape',
   bare.includes('bundle (the small pill immediately right of the lib pill)') &&
   !bare.includes('currently armed:'), bare);
ok('bare chat: the answer rule rides every compose',
   bare.includes('answer from THIS block'), bare);

// 3. UNPRIMED STATE (the 400ms prime cap fired / cold engine): no
//    _pmConn at all — the block degrades, never crashes.
const cold = pmMetadataBlock({ effort: 'med' });
ok('cold engine (no _pmConn): compose survives, pill lines present',
   typeof cold === 'string' && cold.includes('+workspace badge') && cold.includes('answer from THIS block'), cold);

// 4. CONNECTED-BUT-UNBOUND — the helpful middle: the badge names the
//    user's connected count.
const unbound = pmMetadataBlock({
  effort: 'med', _tweaks: {},
  _pmConn: { bound: [], totalWorkspaces: 3 }
});
ok('connected-but-unbound names the total the user can bind',
   unbound.includes('the user has 3 workspace(s) connected'), unbound);

console.log('\n' + PASS + ' passed, ' + FAIL + ' failed');
process.exit(FAIL ? 1 : 0);
