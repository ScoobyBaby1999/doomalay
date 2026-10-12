// ab-fmtw-probe.mjs — the S3 conviction experiment: does the transcript
// complete with the worker path OFF vs ON? (the A/B that pins or exonerates
// the off-thread tail on the live tree)
import { execSync } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';

const ENGINE = 'http://127.0.0.1:8691';
const STUB_PORT = 8692;
const MODEL = 'stub-model';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function ab(args, t) {
  try { return execSync('agent-browser ' + args, { timeout: t || 30000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  catch (e) { return (e.stdout || '') + (e.stderr || '') || ('ERR ' + e.message); }
}
const abEval = (js) => ab('eval ' + JSON.stringify(js), 25000);
const pstr = (js) => { const v = abEval(js); try { const j = JSON.parse(v); if (typeof j === 'string') return j; } catch (e) {} return String(v).replace(/^"|"$/g, ''); };
async function waitFn(js, t) {
  const t0 = Date.now();
  for (;;) {
    const v = String(abEval(js)).trim().replace(/^"|"$/g, '');
    if (v === 'true' || v === 'yes') return true;
    if (Date.now() - t0 > (t || 15000)) return false;
    await sleep(300);
  }
}
async function jpost(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try { return await r.json(); } catch (e) { return {}; }
}

// the stub (same MD shape as the walk)
const MD_TURN = [
  '# The Off-Thread Tail\n\n',
  'A paragraph with **bold**, _italic_ and `inline code` bits.\n\n',
  '```js\nfunction tail(x) { return x + 1; }\n```\n\n',
  '| col a | col b |\n|---|---|\n| 1 | 2 |\n\n',
  '- list one\n- list two\n  - nested\n\n',
  '> a quoted line\n\n',
  'tail text padding the body out so the tiers split. '.repeat(6),
  'more tail text to keep the stream busy. '.repeat(6)
];
function startStub() {
  function sse(res, obj) { res.write('data: ' + JSON.stringify(obj) + '\n\n'); }
  const srv = http.createServer(async (req, res) => {
    const url = req.url.replace(/\?.*$/, '');
    if (req.method === 'POST' && (url === '/chat/completions' || url === '/v1/chat/completions')) {
      let body = ''; for await (const c of req) body += c;
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      for (const ch of MD_TURN) { sse(res, { choices: [{ delta: { content: ch } }] }); await sleep(120); }
      sse(res, { choices: [{ delta: {}, finish_reason: 'stop' }] });
      res.end('data: [DONE]\n\n');
      return;
    }
    if (req.method === 'GET' && (url === '/models' || url === '/v1/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: MODEL }] })); return;
    }
    res.writeHead(404); res.end();
  });
  srv.listen(STUB_PORT, '127.0.0.1');
  return srv;
}

const stubSrv = startStub();
async function runTrial(label, killWorker) {
  const SID = 'ab-fmtw-' + label + '-' + crypto.randomBytes(3).toString('hex');
  await jpost(ENGINE + '/api/sessions', { id: SID, title: 'ab ' + label, model: MODEL, provider: 'groq' });
  ab('open ' + ENGINE + '/?apk=1');
  await sleep(2000);
  if (killWorker) {
    abEval('window.Worker = undefined; "killed"');
    await sleep(200);
  }
  abEval("(window.doomalay && window.doomalay.openChatBySession) ? (window.doomalay.openChatBySession('" + SID + "', {}), 'opened') : 'no api'");
  await waitFn("!!(document.querySelector('#chat-input')||document.querySelector('textarea'))", 10000);
  await sleep(400);
  const fmtw0 = pstr('(JSON.stringify(window.Formatter.__fmtw ? window.Formatter.__fmtw() : null))');
  abEval("(function(){var t=document.querySelector('#chat-input')||document.querySelector('textarea');t.value='markdown turn please';t.dispatchEvent(new Event('input',{bubbles:true}));var s=document.querySelector('[aria-label=\"Send the message\"]');if(!s)return 'no send';s.click();return 'sent'})()");
  await waitFn("(function(){var b=[].slice.call(document.querySelectorAll('.msg-bubble'));return b.some(function(x){return /list two|quoted line/.test(x.textContent||'')})?'yes':'no'})()", 25000);
  await sleep(1200);   // let the final render + any late applies land
  const state = pstr("(function(){var b=[].slice.call(document.querySelectorAll('.msg-bubble[data-msg-role=assistant]'));var t=b.length?b[b.length-1].textContent:'';var P=window.DoomalayPerf||{};return JSON.stringify({len:t.length,h1:/Off-Thread Tail/.test(t),code:/function tail/.test(t),table:/col a/.test(t),list:/list two/.test(t),quote:/quoted line/.test(t),tail2:/keep the stream busy/.test(t),fmtc:P.fmtCount||0,fmtw:(window.Formatter.__fmtw?window.Formatter.__fmtw():null)})})()");
  console.log(label + ': ' + state);
  return JSON.parse(state);
}

console.log('TRIAL A — worker KILLED (the sync control):');
const a = await runTrial('sync', true);
console.log('\nTRIAL B — worker LIVE (the wave path):');
const b = await runTrial('worker', false);
console.log('\nVERDICT: sync complete=' + (a.tail2 && a.list) + ' · worker complete=' + (b.tail2 && b.list));
try { stubSrv.close(); } catch (e) {}
