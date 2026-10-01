#!/bin/bash
# v0893-harness-manual-test.sh — v0.89.3 THE BOT'S OWN MANUAL (user spec:
# "make each sandbox test all its capabilities. the default personas must
# be different… for HF default persona only include the basic tools
# (calculator, time) with the full harness capabilities provided via an
# artifact in the HF chat").
#
# THE CONTRACT:
#  (1) THE PERSONAS DIFFER — the HF default carries the basic-tools
#      baseline (calculator + current time) + the ONE pointer to
#      HARNESS.md and does NOT enumerate the environment; the quick
#      default keeps the classic blocks (library, on-device identity).
#  (2) HF IS SHORTER — the HF persona must be strictly shorter than the
#      quick persona (the whole point: stop burning tokens every turn).
#  (3) THE HARNESS ARTIFACT AUTO-SEEDS on HF chat create (and ONLY HF) —
#      the user reads the bot's complete capability inventory from the
#      drawer; a quick chat seeds nothing.
#  (4) THE MANUAL IS COMPLETE — every registered tool name (the 14 dt_*
#      modules + the brain's custom Strands tools) appears in
#      brain/HARNESS.md (the doc cannot go stale against the registry).
#  (5) zero console errors.
set -u
cd "$(dirname "$0")/.."
ENG=engine/bin/doomalay-engine
DATA=/tmp/doomalay-v0893
export AGENT_BROWSER_SESSION=doomalay-v0893

# v0.89.2 RIG HARDENING: per-run port + OUR child owns the listener.
PORT=$((8300 + $$ % 300))
BASE=http://127.0.0.1:$PORT

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

rm -rf $DATA; mkdir -p $DATA
$ENG -open=false -port=$PORT -data-dir=$DATA >/tmp/v0893-eng.log 2>&1 &
ENGPID=$!
cleanup(){ kill $ENGPID 2>/dev/null; wait $ENGPID 2>/dev/null; agent-browser close >/dev/null 2>&1; }
trap cleanup EXIT
for i in $(seq 1 80); do curl -s $BASE/api/health >/dev/null 2>&1 && break; sleep 0.25; done
curl -s $BASE/api/health >/dev/null 2>&1 || { echo "BOOT FAIL"; exit 1; }
OWNER=$(ss -tlnp 2>/dev/null | grep ":$PORT " | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)
if [ "$OWNER" != "$ENGPID" ]; then
  echo "BOOT FAIL: port $PORT owned by pid ${OWNER:-?}, our engine is $ENGPID (zombie squatter?)"
  exit 1
fi
echo "engine up (pid $ENGPID owns :$PORT)"

agent-browser close >/dev/null 2>&1
sleep 0.6
for i in 1 2 3; do agent-browser open "$BASE" >/dev/null 2>&1 && break; sleep 1; done
for i in 1 2 3 4 5 6; do V=$(agent-browser eval "document.readyState" 2>/dev/null | tr -d '"\n'); [ "$V" = "complete" ] && break; sleep 0.8; done
ev "localStorage.clear()" >/dev/null 2>&1

echo "── (1)+(2) THE PERSONAS: different shapes, HF strictly shorter"
R=$(ev "(async function(){
  for (var i=0;i<30 && !(window.Persona && window.Persona.DEFAULT_PERSONA_HF);i++)
    await new Promise(r=>setTimeout(r,300));
  var hf = window.Persona ? window.Persona.DEFAULT_PERSONA_HF : null;
  var qk = window.Persona ? window.Persona.DEFAULT_PERSONA_QUICK : null;
  if (!hf || !qk) return JSON.stringify({fail:'Persona not loaded'});
  return JSON.stringify({
    hfLen: hf.length, qkLen: qk.length,
    hfHasBasics: hf.indexOf('calculator and the current time') >= 0,
    hfHasPointer: hf.indexOf('HARNESS.md in your workspace') >= 0,
    hfNoEnvEnum: hf.indexOf('full build toolchain') < 0 && hf.indexOf('## Environment') < 0,
    hfKeepsArtifacts: hf.indexOf('## Artifacts') >= 0,
    qkKeepsLibrary: qk.indexOf('## Library') >= 0,
    qkOnDevice: qk.indexOf(\"own device\") >= 0,
    qkNoHarnessPointer: qk.indexOf('HARNESS.md in your workspace') < 0,
    hfShorter: hf.length < qk.length
  });
})()")
ck "HF persona: calculator+time baseline, HARNESS.md pointer, NO env enumeration, artifacts intact" \
  "$(echo "$R" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print('yes' if d.get('hfHasBasics') and d.get('hfHasPointer') and d.get('hfNoEnvEnum') and d.get('hfKeepsArtifacts') else 'no')")" "$R"
ck "quick persona: keeps Library + on-device identity, no harness pointer" \
  "$(echo "$R" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print('yes' if d.get('qkKeepsLibrary') and d.get('qkOnDevice') and d.get('qkNoHarnessPointer') else 'no')")" "$R"
ck "HF persona strictly SHORTER than quick (${R}" \
  "$(echo "$R" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print('yes' if d.get('hfShorter') and d.get('hfLen',0)>0 and d.get('qkLen',0)>0 else 'no')")" "$R"

echo "── (3) THE HARNESS ARTIFACT: seeds on HF create ONLY, carries the manual"
HFID=$(curl -s -X POST "$BASE/api/sessions" -H 'Content-Type: application/json' \
  -d '{"id":"v0893-hf","title":"HF chat","sandbox":"hf","model":"openai/gpt-4o","provider":"openai"}' \
  | python3 -c "import sys,json;print(json.load(sys.stdin).get('ID',''))")
QKID=$(curl -s -X POST "$BASE/api/sessions" -H 'Content-Type: application/json' \
  -d '{"id":"v0893-qk","title":"Quick chat","sandbox":"quick","model":"openai/gpt-4o","provider":"openai"}' \
  | python3 -c "import sys,json;print(json.load(sys.stdin).get('ID',''))")
R=$(curl -s "$BASE/api/sessions/$HFID/artifacts" | python3 -c "
import sys, json
arts = json.load(sys.stdin).get('artifacts') or []
h = [a for a in arts if a.get('name','').lower() == 'harness.md']
print(json.dumps({ 'hfCount': len(arts), 'seeded': len(h) == 1,
  'source': h[0].get('source') if h else None, 'size': h[0].get('size') if h else 0 }))")
HFSEEDED=$(echo "$R" | python3 -c "import sys,json;print('yes' if json.loads(sys.stdin.read()).get('seeded') else 'no')")
ck "HF chat opens with the seeded HARNESS.md artifact" "$HFSEEDED" "$R"
AID=$(curl -s "$BASE/api/sessions/$HFID/artifacts" | python3 -c "
import sys, json
arts = json.load(sys.stdin).get('artifacts') or []
h = [a for a in arts if a.get('name','').lower() == 'harness.md']
print(h[0]['id'] if h else '')")
DOC=$(curl -s "$BASE/api/sessions/$HFID/artifacts/$AID" | python3 -c "
import sys, json
d = json.load(sys.stdin)
c = d.get('content') or ''
print(json.dumps({ 'len': len(c),
  'hasShell': 'shell' in c, 'hasPub': '/pub/<file>' in c,
  'hasHonest': 'cannot' in c.lower() }))")
ck "the seeded doc IS the manual (shell + /pub serving + honest limits)" \
  "$(echo "$DOC" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print('yes' if d['len']>3000 and d['hasShell'] and d['hasPub'] and d['hasHonest'] else 'no')")" "$DOC"
QCOUNT=$(curl -s "$BASE/api/sessions/$QKID/artifacts" | python3 -c "import sys,json;print(len(json.load(sys.stdin).get('artifacts') or []))")
ck "quick chat seeds NOTHING ($QCOUNT artifacts)" "$([ "$QCOUNT" = "0" ] && echo yes || echo no)" "$QCOUNT"

echo "── (4) THE MANUAL IS COMPLETE: every registered tool name appears"
MISSING=$(python3 - <<'PYEOF'
import re, pathlib
root = pathlib.Path('.')
manual = (root / 'brain' / 'HARNESS.md').read_text(encoding='utf-8')
names = []
# the dt registry modules
for f in sorted((root / 'brain' / 'tools').glob('dt_*.py')):
    m = re.search(r'^TOOL_NAMES\s*=\s*\[(.*?)\]', f.read_text(encoding='utf-8'), re.S | re.M)
    if m:
        names += re.findall(r'"([a-z_0-9]+)"', m.group(1))
# the brain's custom Strands tools (agent_core.py @strands_tool_decorator(name="…"))
core = (root / 'brain' / 'agent_core.py').read_text(encoding='utf-8')
names += re.findall(r'strands_tool_decorator\(name="([a-z_0-9]+)"', core)
missing = [n for n in sorted(set(names)) if f'**{n}**' not in manual and f'`{n}`' not in manual and n not in manual]
print(','.join(missing) if missing else 'NONE', f'({len(set(names))} tools checked)')
PYEOF
)
ck "HARNESS.md enumerates every registered tool ($MISSING)" "$([ "${MISSING%% *}" = "NONE" ] || [ -z "$MISSING" ] && echo yes || echo no)" "$MISSING"

echo "── (5) zero console errors"
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
