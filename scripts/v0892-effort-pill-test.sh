#!/bin/bash
# v0892-effort-pill-test.sh — v0.89.2 THE PILL'S WIRE (user spec:
#   "Using privatemodeai, I still can't see the effort mode pill. It's
#    gone. Doesn't render. We can't use kimi or GLM or any of the
#    offered models on actual effort modes.")
#
# Root causes (both fixed this wave):
#   LAYER A (render): the cold-boot static catalog serves every group
#     with models:null; a partial first live sync can lock a provider's
#     group empty for the whole session. Fix: (1) the CLIENT PM docs
#     ladder (docs.privatemode.ai, verified 2026-10-01) answers whenever
#     the catalog has nothing — the PM pill renders on FIRST panel open;
#     (2) THE SELF-HEAL — a null ladder fires ONE /api/models?refresh=1
#     and re-derives (bounded, never loops).
#   LAYER B (the wire): pmsdk's effort mapping — kimi 'off' sent NOTHING
#     (PM's default is thinking ON, so dialing down did nothing). Fix:
#     'off' → chat_template_kwargs.thinking:false (the docs' off-switch);
#     enums (glm/gpt-oss) ride reasoning_effort.
#
# THE CONTRACT:
#  (1) THE PILL RENDERS WITHOUT THE CATALOG — a PM chat on a keyless
#      engine (the privatemodeai group exists with 0 models): kimi-latest
#      → 'effort · on' (client ladder default), cycles on→off→on;
#      glm-5.3 → 'effort · max', cycles max→low→high→max (the wrap);
#      gpt-oss-120b → 'effort · medium'; deepseek-ocr-2 → NO effort
#      button (dial-less).
#  (2) THE SELF-HEAL — a null-ladder build fires EXACTLY ONE
#      /api/models?refresh=1 (spy on fetch), never loops; an honest
#      provider with no ladder (cloudflare, keyless, 0 models) stays
#      pill-less.
#  (3) THE WIRE (Layer B) — PMBridge.__test.roundTrip with a capturing
#      fake core, the REAL body build: kimi 'off' →
#      chat_template_kwargs.thinking===false; kimi 'on' → true;
#      glm 'max' → reasoning_effort==='max' (no chat_template_kwargs);
#      gpt-oss 'low' → reasoning_effort==='low'; no effort → neither.
#  (4) zero console errors.
set -u
cd "$(dirname "$0")/.."
ENG=engine/bin/doomalay-engine
DATA=/tmp/doomalay-v0892
export AGENT_BROWSER_SESSION=doomalay-v0892

ev() { agent-browser eval "$1" 2>/dev/null | python3 -c "
import sys, json
lines = sys.stdin.read().split('\n')
out = ''
for ln in lines:
    ln = ln.strip()
    if not ln: continue
    try:
        v = json.loads(ln)
        if isinstance(v, dict): v = v.get('data',{}).get('result', v)
        if isinstance(v, list) and len(v) == 1: v = v[0]
        out = v
    except Exception:
        pass
print(out, end='')"; }
PASS=0; FAIL=0
ck() { if [ "$2" = "yes" ]; then PASS=$((PASS+1)); echo "  ✓ $1"; else FAIL=$((FAIL+1)); echo "  ✗ $1  → got: ${3:-?}"; fi; }

# v0.89.2 RIG HARDENING — THE ZOMBIE-PORT LESSON: a stale engine
# squatting the fixed port answers the health check, so the rig ran
# its entire contract against an OLD binary (no flag-reset fix, no
# trace hooks) while OUR child died at bind. Now: a per-run port +
# proof that OUR child owns the listener before any test runs.
PORT=$((8300 + $$ % 300))
BASE=http://127.0.0.1:$PORT
rm -rf $DATA; mkdir -p $DATA
$ENG -open=false -port=$PORT -data-dir=$DATA >/tmp/v0892-eng.log 2>&1 &
ENGPID=$!
cleanup(){ kill $ENGPID 2>/dev/null; wait $ENGPID 2>/dev/null; agent-browser close >/dev/null 2>&1; }
trap cleanup EXIT
for i in $(seq 1 80); do curl -s $BASE/api/health >/dev/null 2>&1 && break; sleep 0.25; done
curl -s $BASE/api/health >/dev/null 2>&1 || { echo "BOOT FAIL (engine never answered on $PORT)"; exit 1; }
# THE OWNERSHIP PROOF: the port's listener must be OUR child (a zombie
# squatter serving an old build fails here — the exact live find).
OWNER=$(ss -tlnp 2>/dev/null | grep ":$PORT " | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)
if [ "$OWNER" != "$ENGPID" ]; then
  echo "BOOT FAIL: port $PORT owned by pid ${OWNER:-?}, our engine is $ENGPID (zombie squatter? kill it)"
  exit 1
fi
echo "engine up (pid $ENGPID owns :$PORT)"

agent-browser close >/dev/null 2>&1
sleep 0.6
OPENED=no
for i in 1 2 3; do
  agent-browser open "$BASE" >/dev/null 2>&1 && OPENED=yes && break
  sleep 1
done
READY=no
for i in 1 2 3 4 5 6; do
  V=$(agent-browser eval "document.readyState" 2>/dev/null | tr -d '"\n')
  [ "$V" = "complete" ] && READY=yes && break
  sleep 0.8
done
if [ "$READY" != "yes" ]; then
  echo "BROWSER BOOT FAIL (open=$OPENED ready=$READY)"
  exit 1
fi
ev "localStorage.clear()" >/dev/null 2>&1
ev "window.__btTrace = []" >/dev/null 2>&1

echo "── (1) THE PILL RENDERS WITHOUT THE CATALOG (the client docs ladder)"
R=$(ev "(async function(){
  // wait for the dock (page ready), create a chat, arm a PM model on a
  // KEYLESS engine — the privatemodeai group exists with 0 models, so
  // only the client ladder can answer.
  for (var i=0;i<20 && !document.getElementById('dock-sub');i++) await new Promise(r=>setTimeout(r,300));
  document.getElementById('canvas-empty-btn').click();
  await new Promise(r => setTimeout(r, 1000));
  var c = window.ChatPanel.current(); var cx = c && (c.ctx || c);
  cx.applyModel('privatemodeai', 'privatemodeai/kimi-latest');
  // poll for the pill (the labels re-render)
  var read = function(){
    var bar = document.getElementById('chat-toolbar');
    if (!bar) return '';
    var b = bar.querySelector('button');
    return b ? b.textContent : '';
  };
  var pill1 = '';
  for (var i=0;i<30 && !pill1;i++) { await new Promise(r=>setTimeout(r,300)); pill1 = read(); }
  // cycle on → off → on (the wrap contract: kimi's on/off)
  var clicks = [];
  var bar = document.getElementById('chat-toolbar');
  var btn = bar ? bar.querySelector('button') : null;
  if (btn) { btn.click(); await new Promise(r=>setTimeout(r,400)); clicks.push(read()); }
  if (btn) { bar = document.getElementById('chat-toolbar'); btn = bar ? bar.querySelector('button') : null;
             if (btn) { btn.click(); await new Promise(r=>setTimeout(r,400)); clicks.push(read()); } }
  return JSON.stringify({ pill1: pill1, clicks: clicks });
})()")
ck "kimi-latest: the pill renders 'effort · on' with NO key + NO catalog models; cycles on→off→on" \
  "$(echo "$R" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());
ok = d['pill1']=='effort · on' and len(d['clicks'])>=2 and d['clicks'][0]=='effort · off' and d['clicks'][1]=='effort · on'
print('yes' if ok else 'no')")" "$R"

R=$(ev "(async function(){
  var c = window.ChatPanel.current(); var cx = c && (c.ctx || c);
  cx.applyModel('privatemodeai', 'privatemodeai/glm-5.3');
  var read = function(){ var b=document.getElementById('chat-toolbar'); b=b&&b.querySelector('button'); return b?b.textContent:''; };
  var p = '';
  for (var i=0;i<30 && !p;i++) { await new Promise(r=>setTimeout(r,300)); p = read(); }
  // cycle: max → low → high → max (the enum WRAPS, no dead end)
  var seq = [p];
  for (var k=0;k<3;k++) {
    var bar = document.getElementById('chat-toolbar');
    var btn = bar ? bar.querySelector('button') : null;
    if (!btn) break;
    btn.click(); await new Promise(r=>setTimeout(r,400)); seq.push(read());
  }
  return JSON.stringify({ seq: seq });
})()")
ck "glm-5.3: 'effort · max' default, cycles max→low→high→max (enum WRAPS)" \
  "$(echo "$R" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());
s=d['seq']; ok = s[0]=='effort · max' and len(s)>=4 and s[1]=='effort · low' and s[2]=='effort · high' and s[3]=='effort · max'
print('yes' if ok else 'no')")" "$R"

R=$(ev "(async function(){
  var c = window.ChatPanel.current(); var cx = c && (c.ctx || c);
  cx.applyModel('privatemodeai', 'privatemodeai/gpt-oss-120b');
  var read = function(){ var b=document.getElementById('chat-toolbar'); b=b&&b.querySelector('button'); return b?b.textContent:''; };
  var p = '';
  for (var i=0;i<30 && !p;i++) { await new Promise(r=>setTimeout(r,300)); p = read(); }
  cx.applyModel('privatemodeai', 'privatemodeai/deepseek-ocr-2');
  var none = '';
  for (var i=0;i<20;i++) { await new Promise(r=>setTimeout(r,300));
    var bar = document.getElementById('chat-toolbar');
    // v0.89.2 fix: scan ALL buttons — the lib pill (🛠 lib) can be the
    // first button; the effort control is identified by its text.
    var eb = null;
    if (bar) { (bar.querySelectorAll('button') || []).forEach(function(b){ if (/^effort/.test(b.textContent||'')) eb = b; }); }
    none = bar ? (eb ? eb.textContent : 'NO-BTN') : 'NO-BAR';
    if (none) break;
  }
  return JSON.stringify({ gptoss: p, ocr: none });
})()")
ck "gpt-oss: 'effort · medium' default; deepseek-ocr-2: NO effort button" \
  "$(echo "$R" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());
print('yes' if d['gptoss']=='effort · medium' and d['ocr'] in ('NO-BTN',) else 'no')")" "$R"

echo "── (2) THE SELF-HEAL — one refresh, never a loop"
R=$(ev "(async function(){
  // spy on the ?refresh=1 lane
  window.__refreshCount = 0;
  var orig = window.fetch;
  window.fetch = function(u, o){
    if (String(u).indexOf('/api/models?refresh=1') >= 0) window.__refreshCount++;
    return orig.apply(this, arguments);
  };
  var c = window.ChatPanel.current(); var cx = c && (c.ctx || c);
  // cloudflare: keyless, 0 models — a group that exists but can never
  // answer. The self-heal fires ONE refresh; nothing loops.
  cx.applyModel('cloudflare', 'cloudflare/llama-3.1-8b');
  await new Promise(r => setTimeout(r, 3500));
  var count1 = window.__refreshCount;
  await new Promise(r => setTimeout(r, 2500));
  var bar = document.getElementById('chat-toolbar');
  var anyEffort = false;
  if (bar) { (bar.querySelectorAll('button') || []).forEach(function(b){ if (/^effort/.test(b.textContent||'')) anyEffort = true; }); }
  return JSON.stringify({
    refreshes1: count1,
    refreshes2: window.__refreshCount,
    stillOne: window.__refreshCount === count1 && count1 === 1,
    noFakePill: !anyEffort,
    traceLen: window.__btTrace ? window.__btTrace.length : -1,
    traceTail: window.__btTrace ? window.__btTrace.slice(-10) : null,
    stateNow: (function(){ var cc = window.ChatPanel.current(); return cc && cc.state ? {provider: cc.state.provider, model: cc.state.model, flag: !!cc.state._effortRefreshed} : null; })()
  });
})()")
ck "a null-ladder build fires EXACTLY ONE ?refresh=1 (no loop); no phantom pill for cloudflare" \
  "$(echo "$R" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print('yes' if d['stillOne'] and d['noFakePill'] else 'no')")" "$R"

echo "── (3) THE WIRE — the REAL body build (capturing fake core)"
R=$(ev "(async function(){
  if (!window.PMBridge || !window.PMBridge.__test) return JSON.stringify({fail:'no PMBridge'});
  var T = window.PMBridge.__test;
  var caps = [];
  var mkCore = function(){
    return { streamChatCompletions: async function(body, o){
      caps.push(JSON.parse(JSON.stringify(body)));
      var self = this;
      return (async function* (){
        yield {choices:[{delta:{content:'OK'}}]};
        yield {choices:[{delta:{}}], usage:{prompt_tokens:1, completion_tokens:1}};
      })();
    } };
  };
  var msgs = [{role:'user', content:'hi'}];
  var calls = [
    ['kimi-off',   {model:'privatemodeai/kimi-latest', effort:'off'}],
    ['kimi-on',    {model:'privatemodeai/kimi-k2.6',  effort:'on'}],
    ['glm-max',    {model:'privatemodeai/glm-5.3',    effort:'max'}],
    ['glm-low',    {model:'privatemodeai/glm-latest', effort:'low'}],
    ['gptoss-low', {model:'privatemodeai/gpt-oss-120b', effort:'low'}],
    ['none',       {model:'privatemodeai/glm-5.3',    effort:''}]
  ];
  var out = {};
  for (var i = 0; i < calls.length; i++) {
    var name = calls[i][0], opts = calls[i][1];
    opts.onDelta = function(){}; opts.onProgress = function(){}; opts.onStatus = function(){};
    var before = caps.length;
    var res = await T.roundTrip(mkCore(), opts, msgs);
    var b = caps[before] || {};
    out[name] = {
      text: (res && res.text || '').slice(0, 8),
      ctk: b.chat_template_kwargs ? (b.chat_template_kwargs.thinking !== undefined ? b.chat_template_kwargs.thinking : (b.chat_template_kwargs.enable_thinking !== undefined ? 'eth:' + b.chat_template_kwargs.enable_thinking : 'obj')) : null,
      re: b.reasoning_effort || null
    };
  }
  return JSON.stringify(out);
})()")
ck "kimi off/on, glm max/low, gpt-oss low, none — the exact wire shapes per docs" \
  "$(echo "$R" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());
try:
  ok = (d['kimi-off']['ctk'] is False and d['kimi-off']['re'] is None and d['kimi-off']['text'].startswith('OK'))
  ok = ok and d['kimi-on']['ctk'] is True and d['kimi-on']['re'] is None
  ok = ok and d['glm-max']['re'] == 'max' and d['glm-max']['ctk'] is None
  ok = ok and d['glm-low']['re'] == 'low'
  ok = ok and d['gptoss-low']['re'] == 'low' and d['gptoss-low']['ctk'] is None
  ok = ok and d['none']['re'] is None and d['none']['ctk'] is None
  print('yes' if ok else 'no')
except Exception as e:
  print('no')")" "$R"

# ── (5) THE LIVE PM TURN ────────────────────────────────────────────
# Gated on PM_KEY (never committed): a REAL privatemode.ai round trip
# through the app's own PMBridge — kimi with effort OFF (thinking:false
# — the fix; the old send-nothing left kimi reasoning at PM's default
# ON) and glm-5.3 dialed to low (reasoning_effort — the literal_error
# 400 class). Both must land a real answer, no error row.
if [ -n "${PM_KEY:-}" ]; then
  echo "── (5) THE LIVE PM TURN (real key, real round trips)"
  # seed the key + wait for the live PM group to fill
  curl -s -X POST "$BASE/api/keys" -H 'Content-Type: application/json' \
    -d "{\"provider\":\"privatemodeai\",\"key\":\"$PM_KEY\"}" >/dev/null
  KIMI_ID=""; GLM_ID=""
  for i in $(seq 1 40); do
    IDS=$(curl -s "$BASE/api/models" | python3 -c "
import sys, json
try:
  d = json.load(sys.stdin)
  pm = [g for g in (d.get('groups') or []) if g.get('name') == 'privatemodeai']
  ids = [m.get('id','') for m in ((pm[0].get('models') or []) if pm else [])]
  kimi = [i for i in ids if 'kimi' in i.lower()]
  glm = [i for i in ids if 'glm' in i.lower()]
  print((kimi[0] if kimi else '') + '|' + (glm[0] if glm else ''))
except Exception:
  print('|')")
    KIMI_ID="${IDS%%|*}"; GLM_ID="${IDS##*|}"
    [ -n "$KIMI_ID" ] && [ -n "$GLM_ID" ] && break
    sleep 1
  done
  ck "live catalog: PM kimi + glm present after key seed (kimi=$KIMI_ID glm=$GLM_ID)" \
    "$([ -n "$KIMI_ID" ] && [ -n "$GLM_ID" ] && echo yes || echo no)" "$IDS"

  if [ -n "$KIMI_ID" ] && [ -n "$GLM_ID" ]; then
    # (5a) kimi OFF — the real thinking:false round trip
    R=$(ev "(async function(){
      var c = window.ChatPanel.current(); var cx = c && (c.ctx || c);
      cx.applyModel('privatemodeai', '$KIMI_ID');
      var read = function(){ var b=document.getElementById('chat-toolbar'); b=b&&b.querySelector('button'); return b?b.textContent:''; };
      var p = '';
      for (var i=0;i<40 && !/^effort/.test(p);i++) { await new Promise(r=>setTimeout(r,300)); p = read(); }
      if (!/^effort/.test(p)) return JSON.stringify({fail:'no pill', p: p});
      if (p !== 'effort · off') { // default is ON — click once to OFF
        var bar = document.getElementById('chat-toolbar');
        var btn = bar && bar.querySelector('button');
        if (btn) { btn.click(); await new Promise(r=>setTimeout(r,400)); }
      }
      var off = read();
      var inp = document.getElementById('chat-input');
      if (!inp) return JSON.stringify({fail:'no input', off: off});
      inp.value = 'Reply with exactly: PONG';
      inp.dispatchEvent(new Event('input', {bubbles:true}));
      var snd = document.getElementById('chat-send');
      if (!snd) return JSON.stringify({fail:'no send', off: off});
      var before = document.querySelectorAll('#chat-messages .msg-row-assistant').length;
      snd.click();
      // wait for a NEW assistant row (real turn; generous)
      var ans = '';
      for (var i=0;i<90 && !ans;i++) {
        await new Promise(r=>setTimeout(r,1000));
        var rows = document.querySelectorAll('#chat-messages .msg-row-assistant');
        if (rows.length > before) ans = (rows[rows.length-1].textContent||'').slice(0,200);
      }
      var errRow = document.querySelector('#chat-messages .msg-row-error');
      return JSON.stringify({ off: off, ans: ans, err: errRow ? errRow.textContent.slice(0,120) : null });
    })()")
    ck "kimi effort=OFF (thinking:false): real answer lands, no error" \
      "$(echo "$R" | python3 -c "import sys,json
try:
  d=json.loads(sys.stdin.read())
  print('yes' if d.get('off')=='effort · off' and d.get('ans') and not d.get('err') and 'fail' not in d else 'no')
except Exception: print('no')")" "$R"

    # (5b) glm LOW — the real reasoning_effort round trip
    R=$(ev "(async function(){
      var c = window.ChatPanel.current(); var cx = c && (c.ctx || c);
      cx.applyModel('privatemodeai', '$GLM_ID');
      var read = function(){ var b=document.getElementById('chat-toolbar'); b=b&&b.querySelector('button'); return b?b.textContent:''; };
      var p = '';
      for (var i=0;i<40 && !/^effort/.test(p);i++) { await new Promise(r=>setTimeout(r,300)); p = read(); }
      if (!/^effort/.test(p)) return JSON.stringify({fail:'no pill', p: p});
      // ladder low→high→max: from max, two clicks land on low; from low, two clicks land on high→max... normalize: click until 'low'
      var guard = 0;
      while (read() !== 'effort · low' && guard < 5) {
        var bar = document.getElementById('chat-toolbar');
        var btn = bar && bar.querySelector('button');
        if (!btn) break;
        btn.click(); await new Promise(r=>setTimeout(r,400)); guard++;
      }
      var low = read();
      var inp = document.getElementById('chat-input');
      if (!inp) return JSON.stringify({fail:'no input', low: low});
      inp.value = 'Reply with exactly: PONG2';
      inp.dispatchEvent(new Event('input', {bubbles:true}));
      var snd = document.getElementById('chat-send');
      if (!snd) return JSON.stringify({fail:'no send', low: low});
      var before = document.querySelectorAll('#chat-messages .msg-row-assistant').length;
      snd.click();
      var ans = '';
      for (var i=0;i<90 && !ans;i++) {
        await new Promise(r=>setTimeout(r,1000));
        var rows = document.querySelectorAll('#chat-messages .msg-row-assistant');
        if (rows.length > before) ans = (rows[rows.length-1].textContent||'').slice(0,200);
      }
      var errRow = document.querySelector('#chat-messages .msg-row-error');
      return JSON.stringify({ low: low, ans: ans, err: errRow ? errRow.textContent.slice(0,120) : null });
    })()")
    ck "glm effort=low (reasoning_effort): real answer lands, no literal 400" \
      "$(echo "$R" | python3 -c "import sys,json
try:
  d=json.loads(sys.stdin.read())
  print('yes' if d.get('low')=='effort · low' and d.get('ans') and not d.get('err') and 'fail' not in d else 'no')
except Exception: print('no')")" "$R"
  fi
else
  echo "── (5) THE LIVE PM TURN: SKIPPED (PM_KEY not set)"
fi

echo "── (4) zero console errors"
ERRS=$(agent-browser errors --json 2>/dev/null | python3 -c "
import sys, json
try:
  d = json.loads(sys.stdin.read())
  print(len(d.get('data',{}).get('errors', [])))
except Exception:
  print('?')" )
ck "zero console errors" "$([ "$ERRS" = "0" ] && echo yes || echo no)" "errors=$ERRS"

echo
echo "RESULT: $PASS pass, $FAIL fail"
[ $FAIL -eq 0 ] && echo "ALL GREEN" || exit 1
