// v1220-mirror-rig.cjs — PLAN-V122 §3 THE MIRROR battery: the portable
// preamble file format (frontmatter build/parse round-trip), the persona.js
// preamble twins, and the persisted contracts (engine composition keys, the
// PM twin wiring, the hub import branches, the placeholder vocabulary).
const path = require('path');
const fs = require('fs');
const WEB = path.join(__dirname, '..', 'engine', 'internal', 'server', 'web');

let pass = 0, total = 0;
function ck(name, ok, detail) {
  total++; if (ok) { pass++; console.log(`  PASS ${name}`); }
  else console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
}

// ── the persona.js preamble twins (module export path) ────────────────
// persona.js exports via window.Persona; for node, eval the IIFE with a
// stubbed window/document and read off the exposed object.
function loadPersona() {
  const src = fs.readFileSync(path.join(WEB, 'persona.js'), 'utf8');
  const sandbox = {
    window: { addEventListener() {}, DoomToast() {}, location: { protocol: 'http:' } },
    document: { getElementById: () => null, head: null, addEventListener() {}, createElement: () => ({ style: {} }) },
    fetch: () => new Promise(() => {}),          // module-load warm fetches never resolve in the rig
    Promise: Promise, console: console, Date: Date, Object: Object, String: String, Array: Array, Math: Math, JSON: JSON,
  };
  sandbox.window.window = sandbox.window;
  sandbox.window.fetch = sandbox.fetch;
  const vm = require('vm');
  const ctx = vm.createContext(sandbox);
  vm.runInContext(src, ctx);
  return { P: sandbox.window.Persona };
}
const { P } = loadPersona();
{
  ck('persona.js exposes the preamble twins',
    !!(P && P.DEFAULT_PREAMBLE_QUICK && P.defaultPreambleFor && P.buildPreambleFile && P.parsePreambleFile && P.PREAMBLE_BLOCKS));
  const dp = P.defaultPreambleFor('quick');
  ck('the default preamble carries every block slot',
    P.PREAMBLE_BLOCKS.every(b => dp.indexOf('{' + b + '}') >= 0), dp.slice(0, 80));
  ck('the default preamble carries the identity line + {date}',
    dp.startsWith('You are {model}, hosted via {provider}') && dp.indexOf('{date}') > 0);
  const hf = P.defaultPreambleFor('hf');
  ck('the HF variant names the Space', /from your Hugging Face Space/.test(hf));

  // the portable FILE round-trip
  const body = 'You are {model}. Today is {date}.\n\n{repo_access}\n\n{artifacts}\n\n{library}\n\n{controls}\n\n{session}';
  const file = P.buildPreambleFile('My Brief', body);
  ck('the file opens with frontmatter', file.startsWith('---\nname: My Brief\n'));
  ck('the frontmatter documents the placeholders',
    /placeholders: repo_access, artifacts, library, controls, session, model, date/.test(file), file.split('\n')[3]);
  const back = P.parsePreambleFile(file);
  ck('parse: name round-trips', back.name === 'My Brief');
  ck('parse: body round-trips byte-exact', back.body === body);
  const bare = P.parsePreambleFile('no frontmatter here\njust text');
  ck('parse: a bare body passes through', bare.body === 'no frontmatter here\njust text' && bare.name === '');
}

// ── the persisted contracts ────────────────────────────────────────────
{
  const personaSrc = fs.readFileSync(path.join(WEB, 'persona.js'), 'utf8');
  ck('the Preamble row rides UNDER the placeholders row',
    personaSrc.indexOf('data-placeholders="1"') < personaSrc.indexOf('data-preamble="1"'));
  ck('persistPreambles PATCHes only its own keys',
    /preambles: JSON\.stringify\(preambles\),\s*\n\s*preamble_sel: preambleSel/.test(personaSrc));
  ck('the preamble editor has the persona action set (save/default/dl/publish/trash/use)',
    ['pb-save', 'pb-default', 'pb-dl', 'pb-publish', 'pb-del', 'pb-use'].every(id => personaSrc.indexOf('id="' + id + '"') >= 0));
  ck('substituteAll knows {date}', /\{date\}'\)\.join\(new Date\(\)/.test(personaSrc));

  const cp = fs.readFileSync(path.join(WEB, 'chatpanel.js'), 'utf8');
  ck('the PM twin expands every block',
    ['pmRepoAccessBlock(state)', "PM_ARTIFACT_PROMPT", 'pmLibraryPreamble(state)', 'pmMetadataBlock(state)', 'pmSessionContext(state)']
      .every(x => cp.indexOf(x) >= 0));
  ck('the PM twin honors off', /sel !== 'off'/.test(cp));
  ck('state hydration reads Preambles/PreambleSel', /data\.Preambles/.test(cp) && /data\.PreambleSel/.test(cp));
  ck('the persona-saved broadcast carries preambles', /detail\.preambles/.test(cp));

  const hi = fs.readFileSync(path.join(WEB, 'hubitem.js'), 'utf8');
  ck('the hubitem import branch rides', /cur\.type === 'preamble'\) importPreamble/.test(hi));
  const hb = fs.readFileSync(path.join(WEB, 'hub.js'), 'utf8');
  ck('the hub bundle twin rides', /type === 'preamble'\) importPreambleInto/.test(hb));
  const hp = fs.readFileSync(path.join(WEB, 'hubpublish.js'), 'utf8');
  ck('the publish maps know preamble', /preamble: '\.md'/.test(hp) && /type === 'preamble'\) return/.test(hp));

  // engine composition contracts
  const go = fs.readFileSync(path.join(__dirname, '..', 'engine', 'internal', 'server', 'preambles.go'), 'utf8');
  ck('the engine default preamble template matches the JS twin (the identity line)',
    go.indexOf("You are {model}, hosted via {provider}") > 0);
  ck('the engine expansion covers every block',
    ['{repo_access}', '{artifacts}', '{library}', '{controls}', '{session}', '{date}'].every(k => go.indexOf(k) >= 0));
  const chat = fs.readFileSync(path.join(__dirname, '..', 'engine', 'internal', 'server', 'chat.go'), 'utf8');
  ck('the engine composes preamble-then-persona', /preambleTextFor\(sess\)/.test(chat) && /expandPromptBlocks\(composed/.test(chat));
  ck('the default persona no longer carries the library block',
    !/defaultPersonaQuick \+ libraryPreamble/.test(chat) && !/defaultPersonaHF[^;]*libraryPreamble/.test(chat));
  ck('the llm-side workspace manifest prepend is retired on the direct path', /WorkspaceManifest: ""/.test(chat));
  const store = fs.readFileSync(path.join(__dirname, '..', 'engine', 'internal', 'store', 'db.go'), 'utf8');
  ck('the store migration carries both columns', /preambles TEXT/.test(store) && /preamble_sel TEXT/.test(store));
}

console.log(`\nTOTAL: ${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
