#!/bin/bash
# v40-visual.sh — visual QA screenshots of the v0.40 UI (real vault engine).
DATA=/tmp/doomalay-v40vis
PORT=8159
BASE=http://127.0.0.1:$PORT
ENG=/home/z/doomalay/engine/doomalay-engine
export AGENT_BROWSER_SESSION=doomalay-v40vis
OUT=/home/z/my-project/download
mkdir -p $OUT

rm -rf $DATA; mkdir -p $DATA
cp -r /tmp/doomalay-v38nt/* $DATA/
echo "brain_dir: $DATA/no-brain" > $DATA/nobrain.yaml
$ENG -open=false -port=$PORT -data-dir=$DATA -config=$DATA/nobrain.yaml >/tmp/v40vis-eng.log 2>&1 &
ENGPID=$!
cleanup() { kill $ENGPID 2>/dev/null; wait 2>/dev/null; agent-browser close 2>/dev/null; }
trap cleanup EXIT
for i in $(seq 1 80); do curl -s $BASE/api/health >/dev/null 2>&1 && break; sleep 0.25; done

# a fresh chat for starters + a long chat for find/jump
SIDA=$(curl -s -X POST $BASE/api/sessions -H 'Content-Type: application/json' \
  -d '{"title":"Fresh","sandbox":"quick","model":"nvidia/z-ai/glm-5.3-flash","provider":"nvidia"}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["ID"])')
curl -s -X POST $BASE/api/sessions/$SIDA/events -H 'Content-Type: application/json' -d '{"type":"status","text":"{\"state\":\"idle\"}"}' >/dev/null
SIDB=$(curl -s -X POST $BASE/api/sessions -H 'Content-Type: application/json' \
  -d '{"title":"Long","sandbox":"quick","model":"nvidia/z-ai/glm-5.3-flash","provider":"nvidia"}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["ID"])')
for i in $(seq 1 12); do
  curl -s -X POST $BASE/api/sessions/$SIDB/events -H 'Content-Type: application/json' -d "{\"type\":\"user\",\"text\":\"question $i about pineapples and quantum entanglement\"}" >/dev/null
  curl -s -X POST $BASE/api/sessions/$SIDB/events -H 'Content-Type: application/json' -d "{\"type\":\"assistant\",\"text\":\"Answer $i: pineapples grow quantum crowns in tropical superposition. The entanglement of bromelain and spacetime is well documented across many universes and longitudinal studies of fruit.\"}" >/dev/null
done
curl -s -X POST $BASE/api/sessions/$SIDB/events -H 'Content-Type: application/json' -d '{"type":"status","text":"{\"state\":\"idle\"}"}' >/dev/null

agent-browser set viewport 400 760 >/dev/null
agent-browser open $BASE/ >/dev/null; sleep 1.5

seticon() { agent-browser eval "localStorage.setItem('doomalay.state.v2', JSON.stringify({offset:{x:0,y:0},scale:1,currentFamily:'nvidia',icons:[{id:'f1',type:'chat',name:'$2',family:'nvidia',iconIndex:0,x:120,y:200,vx:0,vy:0,radius:28,sandbox:'quick',model:'$3',provider:'nvidia',sessionId:'$1'}],savedAt:Date.now()}))" >/dev/null; agent-browser reload >/dev/null; sleep 1.5; agent-browser mouse move 120 200 >/dev/null; agent-browser mouse down >/dev/null; agent-browser mouse up >/dev/null; sleep 3.5; }

# 1. fresh chat: starter chips
seticon "$SIDA" "Fresh" "nvidia/z-ai/glm-5.3-flash"
agent-browser screenshot $OUT/v40-starter-chips.png >/dev/null && echo "shot: starter chips"

# 2. long chat: find bar (inside composer now)
seticon "$SIDB" "Long" "nvidia/z-ai/glm-5.3-flash"
agent-browser eval "(() => { const b=[...document.querySelectorAll('#chat-toolbar button')].find(x=>/find/i.test(x.textContent||'')); if(b) b.click(); return 'ok'; })()" >/dev/null
sleep 1
agent-browser screenshot $OUT/v40-find-bar.png >/dev/null && echo "shot: find bar (in-composer)"

# 3. scrolled up: jump pill
agent-browser eval "(() => { const s=document.getElementById('chat-scroll'); s.scrollTop = 0; s.dispatchEvent(new Event('scroll')); return 'ok'; })()" >/dev/null
sleep 0.8
agent-browser screenshot $OUT/v40-jump-pill.png >/dev/null && echo "shot: jump pill"

# 4. model-gone error chips (seeded via events API with a suggest payload — visual only)
agent-browser press Escape >/dev/null; sleep 0.4
curl -s -X POST $BASE/api/sessions/$SIDB/events -H 'Content-Type: application/json' \
  -d '{"type":"error","text":"{\"error\":\"model_gone\",\"message\":\"this model has been retired by the provider (end of life) — pick another model\",\"provider\":\"nvidia\",\"model\":\"dead/one\",\"suggest\":[{\"provider\":\"nvidia\",\"model\":\"nvidia/z-ai/glm-5.3\",\"label\":\"GLM 5.3\"},{\"provider\":\"nvidia\",\"model\":\"nvidia/z-ai/glm-5.3-flash\",\"label\":\"GLM 5.3 Flash\"},{\"provider\":\"nvidia\",\"model\":\"nvidia/openai/gpt-oss-20b\",\"label\":\"GPT OSS 20b\"}]}"}' >/dev/null
agent-browser reload >/dev/null; sleep 1.5
agent-browser mouse move 120 200 >/dev/null; agent-browser mouse down >/dev/null; agent-browser mouse up >/dev/null; sleep 3.5
agent-browser eval "(() => { const s=document.getElementById('chat-scroll'); s.scrollTop = s.scrollHeight; return 'ok'; })()" >/dev/null; sleep 0.6
agent-browser screenshot $OUT/v40-recovery-chips.png >/dev/null && echo "shot: recovery chips"
echo "done"
