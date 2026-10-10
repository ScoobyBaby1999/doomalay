#!/usr/bin/env node
// v1212-cleansing-rig.mjs — PLAN-V122 §1 THE CLEANSING battery.
// Pure-frontend shapes (capabilities rowsFor/chipFor) + the persisted file
// contracts (no dead rows, the lib-only flip, the persona-last order, the
// sub texts, the sync event wiring).
const fs = require('fs');
const path = require('path');
const WEB = path.join(__dirname, '..', 'engine', 'internal', 'server', 'web');

let pass = 0, total = 0;
function ck(name, ok, detail) {
  total++; if (ok) { pass++; console.log(`  PASS ${name}`); }
  else console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
}

// ── capabilities.js rowsFor (the module's pure exports) ────────────────
const caps = require(path.join(WEB, 'capabilities.js'));
{
  const rows = caps.rowsFor({ libAuto: true }, { personaName: 'Lippy', wsCount: 2, termux: { available: true, ready: false } });
  const keys = rows.map(r => r.key);
  ck('no web_search row', !keys.includes('web_search'), keys.join(','));
  ck('no deep_research row', !keys.includes('deep_research'));
  ck('no skills_auto row', !keys.includes('skills_auto'));
  ck('no template_auto row', !keys.includes('template_auto'));
  ck('order: lib first, persona LAST', keys[0] === 'lib_auto' && keys[keys.length - 1] === 'persona', keys.join(','));
  ck('workspaces sub text', rows.find(r => r.key === 'workspaces').sub === 'repositories and sandboxes connected to the chat');
  const termuxRow = rows.find(r => r.key === 'termux');
  ck('termux sub text (unready)', termuxRow.sub === 'local Linux sandbox (commands, package installs, local storage)');
  const personaRow = rows.find(r => r.key === 'persona');
  ck('persona sub reflects the active name', personaRow.sub === 'active · Lippy', personaRow.sub);
  ck('persona chip set', personaRow.chip.text === 'set');

  const rows2 = caps.rowsFor({}, { personaName: '', wsCount: 0 });
  const p2 = rows2.find(r => r.key === 'persona');
  ck('persona sub falls back to Default', p2.sub === 'active · Default', p2.sub);
  ck('persona chip default', p2.chip.text === 'default');

  const rows3 = caps.rowsFor({}, { personaName: '', termux: { available: true, ready: true } });
  const t3 = rows3.find(r => r.key === 'termux');
  ck('termux sub text (ready, unstacked)', t3.sub === 'tap to stack on this chat', t3.sub);
}

// ── the persisted file contracts ───────────────────────────────────────
{
  const capsSrc = fs.readFileSync(path.join(WEB, 'capabilities.js'), 'utf8');
  ck('capabilities flipToggle has no skills/template branches',
    !/key === 'skills_auto'/.test(capsSrc) && !/key === 'template_auto'/.test(capsSrc) &&
    !/key === 'web_search'/.test(capsSrc) && !/key === 'deep_research'/.test(capsSrc));

  const cp = fs.readFileSync(path.join(WEB, 'chatpanel.js'), 'utf8');
  ck('segPill deleted', !/function segPill\(/.test(cp) && !/function segPlusLabel\(/.test(cp));
  ck('persistCaps sends web_search:true (always-on)', /web_search: true,/.test(cp));
  ck('runWSTurn no longer sends web_search', !/web_search: state\.webSearch/.test(cp));
  ck('runWSTurn still sends deep_research (the library card arms it)', /deep_research: !!state\.deepResearch/.test(cp));
  ck('clear no longer kills web search', !/state\.webSearch = false;/.test(cp));
  ck('caps-changed listener rides chatpanel', /doomalay:caps-changed/.test(cp));

  const tw = fs.readFileSync(path.join(WEB, 'tweaks.js'), 'utf8');
  ck('tweaks setBox fires caps-changed', /doomalay:caps-changed/.test(tw));

  const cc = fs.readFileSync(path.join(WEB, 'chatclient.js'), 'utf8');
  ck('chatclient still forwards deep_research opts (card path)', /opts\.deep_research !== undefined/.test(cc));
}

// ── engine contract (the birth default) ────────────────────────────────
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'engine', 'internal', 'server', 'sessions.go'), 'utf8');
  ck('sessions.go: WebSearch is *bool (omitted births ON)', /WebSearch\s+\*bool\s+`json:"web_search"`/.test(src));
  ck('sessions.go: the always-on default derivation', /webSearchOn := true/.test(src));
}

console.log(`\nTOTAL: ${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
