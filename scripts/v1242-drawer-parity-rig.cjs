#!/usr/bin/env node
// v1242-drawer-parity-rig.cjs — v1.24.2 THE DRAWER PARITY (PLAN-V125 §2).
//
// The user's bug: "pressing a local workspace (local storage) and pressing
// the open in drawer pill takes us to the artifacts panels with a session
// not found error" — while the manual drawer open works perfectly.
//
// ROOT CAUSE: the workspace picker's "open in drawer" button passed the
// WORKSPACE id where Artifacts.openDrawer expects a SESSION id →
// GET /api/sessions/<ws.id>/artifacts → 404 "session not found" → the
// catch replaced the body → renderDeviceSection (the termux/device tree
// with expand/collapse, indentation, the file editor + SAVE-to-disk)
// never ran.
//
// This rig pins:
//   · the click handler's source contracts (sidNow() — never ws.id; the
//     no-session honest toast; the adhoc handoff)
//   · the forwarding chain (openDrawer → renderDeviceSection, chat.adhoc)
//   · BEHAVIOR: renderDeviceSection renders the adhoc termux row when it
//     isn't session-bound, dedupes when it is, and ignores foreign kinds

'use strict';
const fs = require('fs');
const path = require('path');
const WEB = path.join(__dirname, '..', 'engine', 'internal', 'server', 'web');

let pass = 0, total = 0;
function ck(name, ok, detail) {
  total++; if (ok) { pass++; console.log('  PASS ' + name); }
  else console.log('  FAIL ' + name + (detail ? ' — ' + detail : ''));
}

// ── 1. SOURCE CONTRACTS: the click handler ─────────────────────────────
console.log('v1.24.2 THE DRAWER PARITY — the click handler:');
{
  const wsSrc = fs.readFileSync(path.join(WEB, 'workspace.js'), 'utf8');
  const artSrc = fs.readFileSync(path.join(WEB, 'artifacts.js'), 'utf8');

  // the old bug shape is dead: no branch passes ws.id into openDrawer
  const h1 = wsSrc.indexOf("var dr = acts.querySelector('[data-a=\"drawer\"]')");
  const h2 = wsSrc.indexOf("var ch = acts.querySelector('[data-a=\"chat\"]')");
  const clickBlock = h1 >= 0 && h2 > h1 ? wsSrc.slice(h1, h2) : '';
  ck('the drawer click never passes ws.id (the session-not-found killer is dead)',
    clickBlock.indexOf('ws.id') < 0);
  ck('the drawer click passes sidNow()',
    /openDrawer\(\s*sid,/.test(clickBlock) || clickBlock.indexOf('sid,') >= 0);
  ck('the no-session honest toast', clickBlock.indexOf("toast('connect a model first')") >= 0);
  ck('the device/termux row rides along as adhoc', clickBlock.indexOf('adhoc') >= 0 &&
    clickBlock.indexOf("ws : null") >= 0);
  ck('ConnectOverlay still closes before the drawer opens',
    clickBlock.indexOf('window.ConnectOverlay.close()') >= 0);

  // the forwarding chain
  ck('openDrawer reads chat.adhoc', artSrc.indexOf('(chat && chat.adhoc)') >= 0);
  ck('openDrawer forwards adhoc to renderDeviceSection',
    artSrc.indexOf('renderDeviceSection(listEl, sessionId, adhoc)') >= 0);
  ck('the drawer fetch stays session-scoped (list(sessionId) — the artifacts tree)',
    artSrc.indexOf('list(sessionId).then') >= 0);
}

// ── 2. BEHAVIOR: renderDeviceSection + the adhoc law ──────────────────
console.log('renderDeviceSection behavior (real module, stubbed fetch + DOM):');
(async function () {
  // the stub browser surface (the v1232 pattern)
  global.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  global.window = { addEventListener: () => {} };
  global.document = { addEventListener: () => {}, createElement: () => ({ style: {} }) };
  global.location = { protocol: 'http:', host: 'test' };
  function FakeWS() {}
  FakeWS.prototype.send = function () {};
  global.WebSocket = FakeWS;

  const W = require(path.join(WEB, 'workspace.js'));
  const WD = global.window.Workspace;

  // the minimal DOM: a list element + element factory the module can
  // append into (createElement returns fresh nodes; we track them)
  function makeNode() {
    return {
      className: '', textContent: '', _html: '',
      style: { setProperty: () => {}, display: '' },
      children: [], dataset: {},
      set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html; },
      appendChild(c) { this.children.push(c); return c; },
      addEventListener() {}, remove() {},
      set firstChild(v) {}, get firstChild() { return this.children[0] || { textContent: '' }; },
      setAttribute() {}
    };
  }

  const adhoc = {
    id: 'wsADHOC000001', kind: 'termux', name: 'e2e-project',
    meta: { termux: true, termux_path: '/storage/emulated/0/e2e-project', display_path: 'e2e-project' }
  };

  // every node the section builds rides document.createElement — our
  // factory tracks children/html/events so the assertions can read them
  global.document.createElement = makeNode;

  // CASE A: the session has NO bound device/termux rows — the adhoc row
  // still renders (the user's exact walk: local storage → open in drawer)
  global.fetch = (url, opts) => Promise.resolve({
    ok: true, json: () => Promise.resolve({ workspaces: [
      { id: 'wsCLOUD000001', kind: 'github', name: 'some/repo' }
    ] })
  });
  const listEl = { children: [], appendChild(c) { this.children.push(c); return c; } };
  global.window.Workspace.renderDeviceSection(listEl, 'sessAAA', adhoc);
  await new Promise(r => setTimeout(r, 30));
  {
    const rowsA = listEl.children;
    ck('A · the section head renders', rowsA.length > 0 && rowsA[0].className === 'wsc-sec' &&
      rowsA[0].textContent === '📱 DEVICE STORAGE');
    const treeRows = rowsA.filter(n => n.className === 'wsc-row');
    ck('A · the adhoc termux row renders (unbound)', treeRows.length === 1,
      'treeRows=' + treeRows.length);
    ck('A · the row shows the ws name + jailed root',
      treeRows[0] && treeRows[0].innerHTML.indexOf('e2e-project') >= 0);
    ck('A · the row is expandable (the click wires loadTermuxLevel lazily)',
      typeof treeRows[0].addEventListener === 'function');
  }

  // CASE B: the session already binds the adhoc ws → NO duplicate row
  const listElB = { children: [], appendChild(c) { this.children.push(c); return c; } };
  global.fetch = (url, opts) => Promise.resolve({
    ok: true, json: () => Promise.resolve({ workspaces: [adhoc] })
  });
  global.window.Workspace.renderDeviceSection(listElB, 'sessBBB', adhoc);
  await new Promise(r => setTimeout(r, 30));
  const treeRowsB = listElB.children.filter(n => n.className === 'wsc-row');
  ck('B · a bound adhoc dedupes (ONE row, not two)', treeRowsB.length === 1,
    'treeRows=' + treeRowsB.length);

  // CASE C: no adhoc + no device rows → no section at all
  const listElC = { children: [], appendChild(c) { this.children.push(c); return c; } };
  global.fetch = (url, opts) => Promise.resolve({
    ok: true, json: () => Promise.resolve({ workspaces: [] })
  });
  global.window.Workspace.renderDeviceSection(listElC, 'sessCCC', null);
  await new Promise(r => setTimeout(r, 30));
  ck('C · no adhoc + no bound rows → the section stays empty (honest)',
    listElC.children.length === 0, 'children=' + listElC.children.length);

  // CASE D: a foreign adhoc kind (cloud row) never renders in the device section
  const listElD = { children: [], appendChild(c) { this.children.push(c); return c; } };
  global.fetch = (url, opts) => Promise.resolve({
    ok: true, json: () => Promise.resolve({ workspaces: [] })
  });
  global.window.Workspace.renderDeviceSection(listElD, 'sessDDD', { id: 'wsCLOUD2', kind: 'github', name: 'x' });
  await new Promise(r => setTimeout(r, 30));
  ck('D · a cloud adhoc never leaks into the device section', listElD.children.length === 0);

  console.log('\n' + (pass === total ? 'ALL ' + total + ' PASS' : (total - pass) + ' FAIL of ' + total));
  process.exit(pass === total ? 0 : 1);
})().catch(e => { console.error('RIG CRASH', e); process.exit(1); });
