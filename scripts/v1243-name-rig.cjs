#!/usr/bin/env node
// v1243-name-rig.cjs — v1.24.3 THE HONEST NAMES (PLAN-V125 §3).
//
// The user's law: "Workspaces that are from the self-host option when
// added all show up as My Folder. Instead, let's have it dynamically be
// the name of the folder being used as the workspace."
//
// ROOT CAUSE: the literal "My Folder" never existed — the device-picker
// fallbacks are the static strings 'my folder' (termux) / 'my files'
// (desktop), and currentPicker.chat is always null today so the fallback
// ALWAYS fired on an empty name box.
//
// This rig pins:
//   · termuxFolderName (pure): the basename derivation matrix
//   · the termux picker: BOTH submit fallbacks derive the folder name
//     first (the static string is the LAST resort); the placeholder
//     updates on every listing (the suggested name rides navigation)
//   · the desktop twin: the picked handle's name pre-fills an empty box
//     + the submit fallback derives dirHandle.name
//   · the engine twin: workspaces.go derives the basename when a POST
//     arrives nameless (source pin — the Go test pins the behavior)

'use strict';
const fs = require('fs');
const path = require('path');
const WEB = path.join(__dirname, '..', 'engine', 'internal', 'server', 'web');
const GO = path.join(__dirname, '..', 'engine', 'internal', 'server');

let pass = 0, total = 0;
function ck(name, ok, detail) {
  total++; if (ok) { pass++; console.log('  PASS ' + name); }
  else console.log('  FAIL ' + name + (detail ? ' — ' + detail : ''));
}

// ── 1. THE PURE HELPER (the real module) ───────────────────────────────
console.log('v1.24.3 THE HONEST NAMES — termuxFolderName:');
{
  global.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  global.window = { addEventListener: () => {} };
  global.document = { addEventListener: () => {}, createElement: () => ({ style: {} }) };
  global.location = { protocol: 'http:', host: 'test' };
  function FakeWS() {}
  FakeWS.prototype.send = function () {};
  global.WebSocket = FakeWS;
  const W = require(path.join(WEB, 'workspace.js'));

  ck('plain deep path → the folder name',
    W.termuxFolderName('/storage/emulated/0/Doomalay/notes') === 'notes');
  ck('termux home path → the folder name',
    W.termuxFolderName('/data/data/com.termux/files/home/e2e-project') === 'e2e-project');
  ck('trailing slashes trim', W.termuxFolderName('/storage/emulated/0/proj/') === 'proj');
  ck('multi trailing slashes trim', W.termuxFolderName('/storage/emulated/0/proj///') === 'proj');
  ck('the shared root → "0" (the basename — consistent with the Go twin)',
    W.termuxFolderName('/storage/emulated/0') === '0');
  ck('empty / null / garbage → "" (never a crash)',
    W.termuxFolderName('') === '' && W.termuxFolderName(null) === '' &&
    W.termuxFolderName(undefined) === '');
  ck('the bare root "/" → ""', W.termuxFolderName('/') === '');
}

// ── 2. THE TERMUX PICKER CONTRACTS (source) ────────────────────────────
console.log('the termux picker:');
{
  const js = fs.readFileSync(path.join(WEB, 'workspace.js'), 'utf8');

  // both submit sites derive the folder name FIRST
  const derives = (js.match(/\|\| termuxFolderName\(resolved\) \|\| 'my folder'/g) || []).length;
  ck('BOTH submit fallbacks (mkdir + use-this-folder) derive termuxFolderName first',
    derives === 2, 'found ' + derives);
  ck('the static fallback survives as the LAST resort only',
    js.indexOf("termuxFolderName(resolved) || 'my folder'") >= 0);
  ck("currentPicker.chat no longer feeds the termux name (it's always null today)",
    !/currentPicker\.chat \|\| 'my folder'/.test(js));

  // the placeholder rides navigation
  ck('the listing success handler updates the name box placeholder',
    /ninp\.placeholder = hint \|\| 'my folder'/.test(js));
  ck('the placeholder hint derives from the resolved listing path',
    js.indexOf('var hint = termuxFolderName(resolved);') >= 0);

  // the export
  ck('termuxFolderName exports module-style (the rig path)',
    js.indexOf('termuxFolderName: termuxFolderName') >= 0);
}

// ── 3. THE DESKTOP TWIN (source) ───────────────────────────────────────
console.log('the desktop twin:');
{
  const js = fs.readFileSync(path.join(WEB, 'workspace.js'), 'utf8');
  ck('the submit fallback derives dirHandle.name first',
    /\(dirHandle && dirHandle\.name\) \|\| 'my files'/.test(js));
  ck('an empty name box pre-fills with the picked handle name',
    /if \(nameInput && !nameInput\.value\.trim\(\)\) nameInput\.value = h\.name;/.test(js));
}

// ── 4. THE ENGINE TWIN (source; behavior lives in the Go test) ─────────
console.log('the engine twin:');
{
  const go = fs.readFileSync(path.join(GO, 'workspaces.go'), 'utf8');
  const fsGo = fs.readFileSync(path.join(GO, 'termuxfs.go'), 'utf8');
  ck('handleWorkspaceDevice derives the name from the termux path',
    go.indexOf('termuxFolderBase(strings.TrimSpace(req.TermuxPath))') >= 0);
  ck('termuxFolderBase lives in termuxfs.go (the fs twin)',
    fsGo.indexOf('func termuxFolderBase(p string) string') >= 0);
  ck('a truly nameless row stays refused (the honest 400)',
    /if req\.Name == "" \{\s*\n\s*writeError\(w, 400, "name is required"\)/.test(go));
}

console.log('\n' + (pass === total ? 'ALL ' + total + ' PASS' : (total - pass) + ' FAIL of ' + total));
process.exit(pass === total ? 0 : 1);
