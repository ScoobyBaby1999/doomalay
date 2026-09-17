// v28-pm-parser-test.mjs — stupid-proof ACTION parser tests for the PM
// (WebView) path. Extracts the PURE parser blocks from the real vendored
// pmsdk.js source (no window/import deps) and exercises them in Node.
//
// Run: node scripts/v28-pm-parser-test.mjs   (from the repo root)
import { readFileSync } from 'node:fs';

const src = readFileSync('engine/internal/server/web/vendor/pm/pmsdk.js', 'utf8');

function sliceFrom(marker, endMarker) {
  const a = src.indexOf(marker);
  if (a < 0) throw new Error('marker not found: ' + marker);
  const b = src.indexOf(endMarker, a);
  if (b < 0) throw new Error('end marker not found: ' + endMarker);
  return src.slice(a, b);
}

// Block 1: the parser + nudge detectors (self-contained, ES5).
const parserBlock = sliceFrom('var INTENT_PHRASES', 'async function runToolLoop');
// Block 2: repairJSON (lives before INTENT_PHRASES).
const repairBlock = sliceFrom('function repairJSON(', 'function findActionLine');
// Block 3: canonicalizers + lenient JSON.
const canonBlock = sliceFrom('var PM_TOOL_ALIASES', '// execAction — v0.25');

const mod = new Function(repairBlock + '\n' + parserBlock + '\n' + canonBlock + `
  return {
    findActions, findActionLine, isActionLineJS, stripActionDecorations,
    repairJSON, lenientJSONJS, canonicalToolNameJS,
    looksLikeIntentOnly, looksLikeCapabilityDenial, stillMaybePreamble,
    PM_TOOLS_PROTOCOL_ESCAPED_FOR_LEN: undefined
  };
`)();

const { findActions, isActionLineJS, stripActionDecorations, repairJSON,
        lenientJSONJS, canonicalToolNameJS,
        looksLikeIntentOnly, looksLikeCapabilityDenial, stillMaybePreamble } = mod;

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log('  PASS ' + label); }
  else { fail++; console.log('  FAIL ' + label); }
}
function lastAction(reply) {
  const a = findActions(reply);
  return a.length ? a[a.length - 1] : null;
}
function jsonEq(a, b) {
  try { return JSON.stringify(JSON.parse(a)) === JSON.stringify(JSON.parse(b)); }
  catch { return false; }
}

console.log('tolerant ACTION line matching');
ok(lastAction('Action: calculator {"expr": "1+1"}')?.name === 'calculator', 'case-insensitive "Action:"');
ok(lastAction('ACTION : time_now {"tz": "UTC"}')?.name === 'time_now', 'space before colon');
ok(lastAction('ACTION time_now {"tz": "UTC"}')?.name === 'time_now', 'missing colon');
ok(lastAction('**ACTION:** calculator {"expr": "2+2"}')?.name === 'calculator', 'bold with colon inside');
ok(lastAction('**ACTION: calculator** {"expr": "3"}')?.name === 'calculator', 'bold around call');
ok(lastAction('Here it is: `ACTION: time_now {"tz": "UTC"}`')?.name === 'time_now', 'mid-line backtick wrap');
ok(lastAction('> ACTION: time_now {"tz": "UTC"}')?.name === 'time_now', 'quote prefix');
ok(lastAction('- ACTION: time_now {"tz": "UTC"}')?.name === 'time_now', 'bullet prefix');

console.log('prose guards');
ok(findActions('ACTIONS: 1) search the web 2) fetch the repo').length === 0, '"ACTIONS:" plan header not a call');
ok(findActions('Actions speak louder than words.').length === 0, 'prose not a call');
ok(!isActionLineJS('The action: plan begins'), 'lowercase mid-prose not a line');

console.log('lenient JSON args (execAction parse pipeline)');
// mirrors execAction's arg parse exactly: JSON.parse → repair → lenient∘repair
// → bare-string wrap (the function-call/quoted-arg shapes)
function parseArgs(rest) {
  var arg;
  try { arg = JSON.parse(rest); } catch {}
  if (arg === undefined) { try { arg = JSON.parse(repairJSON(rest)); } catch {} }
  if (arg === undefined) { try { arg = JSON.parse(lenientJSONJS(repairJSON(rest))); } catch {} }
  if (arg === undefined) { try { arg = JSON.parse(repairJSON(lenientJSONJS(rest))); } catch {} }
  // a successful parse may still yield a bare STRING (lenient 'Asia/Tokyo' → "Asia/Tokyo")
  // — execAction's typeof-string branch wraps it with every plausible key
  if (typeof arg === 'string') {
    var wrapped = arg.replace(/^["'(`*_-]+/, '').replace(/["')`*_-]+$/, '');
    return { query: wrapped, url: wrapped, text: wrapped, expr: wrapped, pattern: wrapped,
             tz: wrapped, algo: wrapped, name: wrapped, artifact: wrapped,
             prompt: wrapped, id: wrapped, key: wrapped, value: wrapped, mode: wrapped };
  }
  if (arg !== undefined) return arg;
  // nothing parsed — treat the raw rest as the bare string
  var raw = String(rest).replace(/^["'(`*_-]+/, '').replace(/["')`*_-]+$/, '');
  return { query: raw, url: raw, text: raw, expr: raw, pattern: raw,
           tz: raw, algo: raw, name: raw, artifact: raw,
           prompt: raw, id: raw, key: raw, value: raw, mode: raw };
}
function argEq(reply, want) {
  const a = lastAction(reply);
  if (!a) return false;
  const got = parseArgs(a.rest);
  try { return JSON.stringify(got) === JSON.stringify(JSON.parse(want)); }
  catch { return false; }
}
function argField(reply, field) {
  const a = lastAction(reply);
  if (!a) return undefined;
  const got = parseArgs(a.rest);
  return got ? got[field] : undefined;
}
ok(argEq("ACTION: calculator {'expr': '2+2'}", '{"expr":"2+2"}'), 'single-quoted JSON');
ok(argEq('ACTION: calculator {"expr": "2+2",}', '{"expr":"2+2"}'), 'trailing comma');
ok(argEq('ACTION: web_search {\u201cquery\u201d: \u201ccat food\u201d}', '{"query":"cat food"}'), 'smart quotes');
ok(argEq('ACTION: docx_create {name: "r.docx", blocks: []}', '{"name":"r.docx","blocks":[]}'), 'bare keys');
ok(argField('ACTION: calculator ("2*21")', 'expr') === '2*21', 'paren-wrapped bare arg');
ok(argField("ACTION: time_now 'Asia/Tokyo'", 'tz') === 'Asia/Tokyo', 'quoted bare arg');

console.log('truncated JSON (repairJSON still first)');
const trunc = 'ACTION: web_search {"query": "cat diaper how to put on guide"';
ok(argEq(trunc, '{"query":"cat diaper how to put on guide"}'), 'truncated string+braces repaired');

console.log('fuzzy tool names');
ok(canonicalToolNameJS('web_serch') === 'web_search', 'web_serch → web_search');
ok(canonicalToolNameJS('docx_creat') === 'docx_create', 'docx_creat → docx_create');
ok(canonicalToolNameJS('times_now') === 'time_now', 'times_now → time_now');
ok(canonicalToolNameJS('word') === 'docx_create', 'word → docx_create');
ok(canonicalToolNameJS('who_am_i') === 'persona_list', 'who_am_i → persona_list');
ok(canonicalToolNameJS('sing_a_song') === 'sing_a_song', 'distant name stays itself');
ok(canonicalToolNameJS('random_uuid') === 'uuid', 'random_uuid → uuid');

console.log('nudge detectors');
ok(looksLikeIntentOnly('Let me search for that repo.'), 'intent: "Let me search"');
ok(looksLikeIntentOnly("I'll fetch the README now."), 'intent: "I\'ll fetch"');
ok(looksLikeCapabilityDenial("I'm sorry, I don't have access to the internet."), 'denial: no internet');
ok(looksLikeCapabilityDenial('As an AI language model, I cannot access external URLs.'), 'denial: AI language model');
ok(!looksLikeCapabilityDenial('x'.repeat(1500)), 'denial: long answer is not denial');
ok(!looksLikeIntentOnly('x'.repeat(1000)), 'intent: long answer is not intent');

console.log('preamble hold uses tolerant check');
ok(stillMaybePreamble('Step 1 of 12: preparing\n**ACTION**: time_now {"tz"') === true, 'decorated open line still holds');

console.log('\\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
