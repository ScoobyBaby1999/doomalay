#!/usr/bin/env node
// v0935-web-pin.js — the static pins for the REPO-CREATION WAVE's web side.
//
// Guards the three user findings:
//   1. "license 一直 stays none" — loadLists must fire on EVERY form open,
//      never gated on accounts[kind].signed_in at wire time (the async race).
//   2. "no names/descriptions" — license options render {key,name} pairs
//      as "key — Name" (object entries), not bare strings.
//   3. HF repo create "kind must be GitHub|gitea|gitlab" — the HF flow is
//      type-first (space|dataset|model|bucket), sends hf_type + sdk, and
//      the form hides gitignore for HF (not a hub concept).
const fs = require('fs');
const src = fs.readFileSync('engine/internal/server/web/workspace.js', 'utf8');

let pass = 0, fail = 0;
function ck(name, cond) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}`); }
}

// 1. THE RACE — loadLists() must be unconditional now
ck('the signed_in gate is GONE (loadLists fires on every open)',
  !/if \(accounts\[kind\] && accounts\[kind\]\.signed_in\) loadLists\(\);/.test(src));
ck('loadLists() is called unconditionally in wireCreateForm',
  /\n\s*loadLists\(\);\s*\n/.test(src));

// 2. THE NAMES — object entries render key — Name
ck('license entries render {key,name} pairs as "key — Name"',
  /o\.value = l\.key; o\.textContent = l\.key \+ ' — ' \+ l\.name;/.test(src));
ck('bare-string entries still render (backward compat)',
  /else \{ o\.value = l; o\.textContent = l; \}/.test(src));
ck('a failed list load renders the honest note (not a silent none)',
  /couldn\\u2019t load the list/.test(src));

// 3. THE HF TYPE-FIRST FLOW
ck('openCreateForm routes hf to the type chooser',
  /if \(kind === 'hf'\) \{ openHFTypeChooser\(\); return; \}/.test(src));
ck('the chooser offers all four kinds',
  /'space'/.test(src) && /'dataset'/.test(src) && /'model'/.test(src) && /'bucket'/.test(src) &&
  /id="hft-' \+ o\.t/.test(src));
ck('space form carries the SDK select (static default — free)',
  /id="wsc-sdk"/.test(src) && /static — free on every account/.test(src));
ck('bucket form has NO license/gitignore (honest note instead)',
  /buckets are S3-like storage — no license, no card, no git history/.test(src));
ck('the submit payload carries hf_type + sdk for HF',
  /payload\.hf_type = hfType \|\| 'model'/.test(src) && /payload\.sdk = sdkEl\.value;/.test(src));
ck('the HF picker pill names the four kinds',
  /space · dataset · model · bucket/.test(src));
ck('HF create rides the same endpoint (the server does the typing)',
  /api\('\/api\/workspaces\/create-repo', 'POST', payload\)/.test(src));
ck('create success still refreshes the workspaces pill (the count +N)',
  /refreshPills\(\);/.test(src));

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
