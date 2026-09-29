#!/bin/bash
# v0775-pm-nets-test.sh — the PM final-answer safety nets:
#  (1) THE PHANTOM-RECAP FLUSH — a final round whose prose carries a recap
#      ACTION line (suppressed during streaming) must FLUSH its text —
#      the user's "chained tool calls and reasoning bubbles but then
#      didn't output the final result"
#  (2) THE EMPTY-ROUND GUARD (was dead code: `!res.usage` never fired) —
#      a usage-only final round retries once, then surfaces a VISIBLE
#      error instead of a silent idle
#  (3) THE NO-DOUBLE FLUSH — a normally-streamed final never double-flushes
set -u
cd "$(dirname "$0")/.."
ENG=/tmp/doomalay-engine
PORT=8312
BASE=http://127.0.0.1:$PORT
DATA=/tmp/doomalay-v0775
export AGENT_BROWSER_SESSION=doomalay-v0775

ev() { agent-browser eval "$1" 2>/dev/null | python3 -c "
import sys, json
s = sys.stdin.read().strip()
try:
    v = json.loads(s)
    if isinstance(v, dict): v = v.get('data',{}).get('result', v)
    if isinstance(v, list) and len(v) == 1: v = v[0]
    print(v, end='')
except Exception:
    print(s, end='')"; }
PASS=0; FAIL=0
ck() { if [ "$2" = "yes" ]; then PASS=$((PASS+1)); echo "  ✓ $1"; else FAIL=$((FAIL+1)); echo "  ✗ $1  → got: ${3:-?}"; fi; }

rm -rf $DATA; mkdir -p $DATA
$ENG -open=false -port=$PORT -data-dir=$DATA >/tmp/v0775-eng.log 2>&1 &
ENGPID=$!
cleanup(){ kill $ENGPID 2>/dev/null; agent-browser close >/dev/null 2>&1; }
trap cleanup EXIT
for i in $(seq 1 80); do curl -s $BASE/api/health >/dev/null 2>&1 && break; sleep 0.25; done
curl -s $BASE/api/health >/dev/null 2>&1 && echo "engine up" || { echo "BOOT FAIL"; exit 1; }

agent-browser set viewport 420 800 >/dev/null
agent-browser open "$BASE" >/dev/null; sleep 2
agent-browser errors --clear >/dev/null

# a fake PM core: each call pops the next scripted ROUND (a list of SSE
# chunk shapes) and yields them as an async iterable
FAKE_CORE="(function(){
  function fakeCore(rounds) {
    var i = 0;
    return {
      streamChatCompletions: async function () {
        var chunks = rounds[Math.min(i, rounds.length - 1)]; i++;
        return {
          [Symbol.asyncIterator]: async function* () {
            for (var k = 0; k < chunks.length; k++) {
              await new Promise(function (r) { setTimeout(r, 5); });
              yield chunks[k];
            }
          }
        };
      }
    };
  }
  window.__fakeCore = fakeCore;
  return 'fake core ready';
})()"
ev "$FAKE_CORE"

# (1) THE PHANTOM-RECAP FLUSH: round 1 = a real hublib ACTION (carries a
# required arg — executes), round 2 = the final prose ENDING with a recap
# ACTION line missing its required arg (the phantom → the round IS the
# final answer, but its stream was suppressed as an action round)
R1=$(ev "(async function(){
  var T = window.PMBridge.__test;
  var deltas = [];
  var core = window.__fakeCore([
    [ {choices:[{delta:{content:'ACTION: hublib {\"action\":\"search\",\"type\":\"skill\",\"q\":\"test\"}'}}]},
      {choices:[{delta:{}}], usage:{input_tokens:10, output_tokens:5}} ],
    [ {choices:[{delta:{reasoning_content:'thinking about the results…'}}]},
      {choices:[{delta:{content:'The library is your on-device skill collection. I recommend superpowers — it packs brainstorming and planning workflows. (I ran ACTION: hublib {\"action\":\"search\"} to check.)'}}]},
      {choices:[{delta:{}}], usage:{input_tokens:20, output_tokens:40}} ]
  ]);
  var out = await T.runToolLoop(core, {
    model: 'fake/pm', tools: true, lib: false, effort: '',
    messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'what is lib' }],
    onDelta: function (t) { deltas.push(t); },
    onTool: function () {}, onThinking: function () {}, onProgress: function () {}
  });
  var live = deltas.join('');
  return JSON.stringify({ finalLen: (out.text||'').length, liveLen: live.length,
    liveHasIt: live.indexOf('recommend superpowers') >= 0,
    finalHasIt: (out.text||'').indexOf('recommend superpowers') >= 0 });
})()")
FL=$(echo "$R1" | python3 -c "import json,sys; d=json.load(sys.stdin); print('yes' if d.get('liveHasIt') and d.get('finalHasIt') else 'no')")
ck "phantom-recap final flushes through onDelta (live == final)" "$FL" "$R1"

# (2) THE EMPTY-ROUND GUARD: round 1 = real action; rounds 2+3 = usage-only
# (no content) → the guard retries once, then a VISIBLE error
R2=$(ev "(async function(){
  var T = window.PMBridge.__test;
  var core = window.__fakeCore([
    [ {choices:[{delta:{content:'ACTION: time_now {}'}}]},
      {choices:[{delta:{}}], usage:{input_tokens:10, output_tokens:5}} ],
    [ {choices:[{delta:{reasoning_content:'hmm'}}]}, {choices:[{delta:{}}], usage:{input_tokens:1, output_tokens:1}} ],
    [ {choices:[{delta:{}}], usage:{input_tokens:1, output_tokens:1}} ]
  ]);
  try {
    var out = await T.runToolLoop(core, {
      model: 'fake/pm', tools: true, lib: false, effort: '',
      messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }],
      onDelta: function () {}, onTool: function () {}
    });
    return JSON.stringify({ silent: !(out.text||'').trim(), text: (out.text||'').slice(0,60) });
  } catch (e) {
    var msg = String((e && e.message) || e);
    return JSON.stringify({ silent: false, err: msg.slice(0, 90) });
  }
})()")
EG=$(echo "$R2" | python3 -c "
import json,sys
d = json.load(sys.stdin)
ok = (not d.get('silent')) and ('empty response' in (d.get('err','') + d.get('text','')))
print('yes' if ok else 'no')")
ck "usage-only round → visible error (not a silent idle)" "$EG" "$R2"

# (3) THE NO-DOUBLE FLUSH: a clean streamed final (decided='final' live)
# flushes nothing extra — live text == final text exactly once
R3=$(ev "(async function(){
  var T = window.PMBridge.__test;
  var deltas = [];
  var core = window.__fakeCore([
    [ {choices:[{delta:{content:'ACTION: time_now {}'}}]},
      {choices:[{delta:{}}], usage:{input_tokens:10, output_tokens:5}} ],
    [ {choices:[{delta:{content:'It is noon.'}}]},
      {choices:[{delta:{}}], usage:{input_tokens:5, output_tokens:5}} ]
  ]);
  var out = await T.runToolLoop(core, {
    model: 'fake/pm', tools: true, lib: false, effort: '',
    messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'time?' }],
    onDelta: function (t) { deltas.push(t); },
    onTool: function () {}
  });
  var live = deltas.join('');
  return JSON.stringify({ live: live, final: out.text || '', once: live === 'It is noon.' });
})()")
ND=$(echo "$R3" | python3 -c "import json,sys; d=json.load(sys.stdin); print('yes' if d.get('once') else 'no')")
ck "streamed final renders exactly once (no double flush)" "$ND" "$R3"

# console errors
ERRS=$(agent-browser errors 2>/dev/null | head -3)
if [ -z "$ERRS" ]; then ck "zero console errors" yes; else ck "zero console errors" no "$ERRS"; fi

echo ""
echo "v0.77.5 PM-nets suite: $PASS passed, $FAIL failed"
[ $FAIL -eq 0 ]
