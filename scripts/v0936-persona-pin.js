#!/usr/bin/env node
// v0936-persona-pin.js — the static pins for THE PERSONA DEFAULTS WAVE.
//
// The user's spec: "编辑 persona 时 default pill 应按当前 sandbox method
// 重置 persona; 聊天中途切换 sandbox method 时，未编辑过的 persona 应自动
// 切换为新默认". Guards:
//   1. saving a verbatim default stores EMPTY ("follow the mode") — a
//      default never freezes into an edited persona
//   2. the sandbox-changed event re-points unedited personas (persona.js
//      listens; chatpanel's applySandbox dispatches)
//   3. the editor names WHICH mode's default the ↺ pill carries
const fs = require('fs');
const persona = fs.readFileSync('engine/internal/server/web/persona.js', 'utf8');
const chatpanel = fs.readFileSync('engine/internal/server/web/chatpanel.js', 'utf8');

let pass = 0, fail = 0;
function ck(name, cond) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}`); }
}

// 1. THE NO-FREEZE SAVE — verbatim default → '' (follow the mode)
ck('isDefaultTemplate exists (unedited detection)',
  /function isDefaultTemplate\(text\)/.test(persona));
ck('saving a verbatim default stores EMPTY (never freezes)',
  /p\.text = v\.trim\(\) && !isDefaultTemplate\(v\) \? v : ''/.test(persona));
ck('the save toast says "following the sandbox default" when it rides the mode',
  /following the sandbox default/.test(persona));

// 2. THE SWITCH RE-POINT — event pair
ck('persona.js listens for doomalay:sandbox-changed',
  /addEventListener\('doomalay:sandbox-changed'/.test(persona));
ck('the listener clears verbatim-default texts (re-point to the new mode)',
  /isDefaultTemplate\(p\.text\) && String\(p\.text \|\| ''\)\.trim\(\) !== ''/.test(persona));
ck('the listener ignores other sessions (sessionId guard)',
  /d\.sessionId && d\.sessionId !== cur\.sessionId\) return;/.test(persona));
ck('the live editor refreshes to the new mode default on switch',
  /cm\.setValue\(defaultPersonaFor\(cur\.sandbox\)\)/.test(persona));
ck('applySandbox dispatches doomalay:sandbox-changed (chatpanel)',
  /doomalay:sandbox-changed/.test(chatpanel) &&
  /new CustomEvent\('doomalay:sandbox-changed'/.test(chatpanel));
ck('the dispatch carries sessionId + the new sandbox type',
  /sessionId: state\.sessionId \|\| \(icon && icon\.id\) \|\| '', sandbox: sandboxType/.test(chatpanel));

// 3. THE MODE NOTE — the editor says which default ↺ loads
ck('the editor notes which mode default the ↺ pill loads',
  /↺ default loads the <b>' \+/.test(persona) &&
  /cur && cur\.sandbox === 'hf' \? 'Hugging Face sandbox' : 'quick chat'/.test(persona));
ck('the note teaches the contract (switch re-points; edited never moves)',
  /edited text never moves/.test(persona));

// 4. THE DEFAULT PILL — still mode-aware + fresh session per open
ck('the ↺ pill loads defaultPersonaFor(cur.sandbox) (mode-aware)',
  /cm\.setValue\(defaultPersonaFor\(cur && cur\.sandbox\)\)/.test(persona));
ck('loadSession reads Sandbox from the session (fresh per open)',
  /sandbox: \(sess && sess\.Sandbox\) \|\| \(opts && opts\.sandbox\) \|\| 'quick'/.test(persona));

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
