#!/bin/bash
# v065-theme-suite.sh — THE COMPREHENSIVE THEME + COLOR TEST SUITE
#
# USER SPEC (v0.65): "to test out the themes and all their complexity
# through and through with clarity and certainty.. a comprehensive full
# test suite, change every color we have available; both setting theme
# colors (customize theme) and chat colors. Please, select a random
# theme, then for each theme option (canvas, background, accent 1,
# accent 2, ext) go one by one sequentially, make it use a complex
# gradient like one of the diagonals or mesh with like 5+ colors. For
# each variable (canvas, background, accents, ext) visit each page on
# our app and check each screen and every screen and verify that the
# gradient works and the theme works."
#
# THE SUITE (deterministic for a given SEED, recorded in the manifest):
#   p00 base      — the seeded-random theme, pristine (home + chat)
#   p01..p10      — ONE customizable var per phase carrying a 5-6 color
#                   MESH / DIAGONAL / COUNTER-DIAGONAL gradient, EVERY
#                   screen visited + screenshotted (20 screens):
#                     bg-panel (canvas bg) · bg-app (overlay bg) ·
#                     surface-1 · surface-2 · border · text-1 (dark-first)
#                     · accent 1..4
#   p11 text1-l   — primary text with a LIGHT-first gradient (the other
#                   veil-ink direction + the data-text-grad clip paths)
#   p12 schemes   — ALL 10 chat markdown schemes (chat screen each)
#   p13 fmt-grad  — the 5 chat color slots overridden with gradients
#                   (a1/a2/a3/bright/link — 6-color specs)
#   p14 grid-*    — grid lines / dots / origin as mesh specs (canvas)
#   p15 combo     — ALL 10 vars + grid + fmt gradiented AT ONCE, every
#                   screen
#   p16 revert    — overrides cleared; computed styles back at the base
#                   theme values; home/chat/colors shots
#
# Every screenshot records console/page errors + a JSON manifest for
# the VLM audit (scripts/v065-theme-audit.mjs).
#
# Usage: bash scripts/v065-theme-suite.sh [SEED] [--screens=a,b] [--phases=p01,p02] [--out=DIR] [--keep]
set -u

SEED="${1:-}"
SCREENS_FILTER=""
PHASES_FILTER=""
OUT="/home/z/sweep-v065"
KEEP=0
APPEND=0
ENG="${ENG:-/tmp/doomalay-engine}"
for arg in "$@"; do
  case "$arg" in
    --screens=*) SCREENS_FILTER="${arg#--screens=}";;
    --phases=*)  PHASES_FILTER="${arg#--phases=}";;
    --out=*)     OUT="${arg#--out=}";;
    --keep)      KEEP=1;;
    --append)    APPEND=1;;
    [0-9]*)      SEED="$arg";;
  esac
done
SCREENS_FILTER="${SCREENS_FILTER//,/ }"
PHASES_FILTER="${PHASES_FILTER//,/ }"
[ -z "$SEED" ] && SEED=$(( $(date +%s) % 1000000 ))
PORT=8265
BASE=http://127.0.0.1:$PORT
DATA=/tmp/doomalay-v065-suite
export AGENT_BROWSER_SESSION=doomalay-v065-suite

# ── the palettes: 5-6 vivid stops each, DISTINCT hue families so any
#    cross-contamination between vars is unambiguous in screenshots ──
P_CANVAS="['#120b2e','#3b1f5e','#7c2d8f','#b83b5e','#f25f4c','#ffb347']"
P_OVERLAY="['#0d1b2a','#1b4a6b','#2d8fa0','#3bd0c0','#8af2cf','#f2e8cf']"
P_SURF1="['#2e0b3b','#5e1f4e','#8f2d56','#b85e3b','#f28f2d','#ffd24d']"
P_SURF2="['#0b2e2e','#1f5e57','#2d8f7c','#3bb8a0','#7ad0c0','#e8f2cf']"
P_BORDER="['#ff0055','#ff8a00','#ffe600','#00e676','#00c6ff','#a855f7']"
P_TEXT_D="['#1a1a24','#24244e','#2d5e8f','#3ba78f','#5ef2c0','#a8ffe8']"
P_TEXT_L="['#ffffff','#f0f6ff','#c0d8ff','#90b8ff','#6090ff','#3060f0']"
P_ACC1="['#ff0044','#ff5e3a','#ffb03a','#ffe83a','#3affc4','#3a9bff']"
P_ACC2="['#8a2be2','#c71585','#ff1493','#ff6347','#ffa500','#f5f542']"
P_ACC3="['#00ffd5','#00b8ff','#7a5cff','#c400ff','#ff0080','#ff5e00']"
P_ACC4="['#b8ff00','#5eff00','#00ff87','#00d5ff','#5e5cff','#c400ff']"
P_GRID_L="['#7c2d8f','#b83b5e','#f25f4c','#ffb347','#3ba78f','#2d5e8f']"
P_FMT_A1="['#ff0055','#ff8a00','#ffe600','#00e676','#00c6ff']"
P_FMT_A2="['#8a2be2','#ff1493','#ffa500','#00e676','#f5f542']"
P_FMT_A3="['#00ffd5','#00b8ff','#c400ff','#ff0080','#ff5e00']"
P_FMT_BR="['#ffffff','#ffe8f0','#ffd0e8','#ffc0d8','#90b8ff']"
P_FMT_LK="['#00e676','#00c6ff','#3affc4','#7ad0c0','#a855f7']"

THEMES_ALL="midnight nebula ember forest ocean rose mono solar paper frost"
THEME=$(python3 -c "
import random
random.seed($SEED)
print(random.choice('$THEMES_ALL'.split()))")

ALL_SCREENS="home chat chat-code tweaks colors colors-editor sizing general providers models sandbox modelpill workspaces connect library bunch item chatsview search shortcuts"

SHOTLOG=""
INVLOG=""
mkdir -p "$OUT" "$DATA"
if [ "$APPEND" = "0" ]; then
  rm -f "$OUT"/*.png "$OUT"/manifest.ndjson "$OUT"/manifest.json 2>/dev/null
fi

echo "═══ v0.65 THEME SUITE ═══ seed=$SEED random-theme=$THEME out=$OUT"

# ── helpers ──────────────────────────────────────────────────────
ev() { agent-browser eval "$1" 2>/dev/null | python3 -c "
import sys, json
sys.stdout.reconfigure(encoding='utf-8', errors='replace')
s = sys.stdin.read().strip()
try:
    v = json.loads(s)
    if isinstance(v, dict): v = v.get('data',{}).get('result', v)
    if isinstance(v, list) and len(v) == 1: v = v[0]
    print(v, end='')
except Exception:
    print(s, end='')"; }
ab() { agent-browser "$@" >/dev/null 2>&1; }

record() { # phase screen file errs errtxt
  local errs="${4:-0}" errtxt="${5:-}"
  errtxt=$(printf '%s' "$errtxt" | python3 -c "import sys,json;print(json.dumps(sys.stdin.read()[:220]))")
  echo "{\"phase\":\"$1\",\"screen\":\"$2\",\"file\":\"$(basename "$3")\",\"errs\":$errs,\"errtxt\":$errtxt}" >> "$OUT/manifest.ndjson"
}

console_errs() { # prints count<TAB>first-line
  agent-browser errors 2>/dev/null | python3 -c "
import sys
lines=[l.rstrip() for l in sys.stdin if l.strip()]
print('%d|%s' % (len(lines), lines[0][:200] if lines else ''))" 2>/dev/null || echo "0|"
}

shot() { # phase screen
  # NOTE: separate local statements — bash expands ${ph} in a later assignment
  # of the SAME local command BEFORE binding it (dynamic scope made it work
  # when callers had their own ph; a top-level call crashed with
  # "ph: unbound variable" under set -u).
  local ph="$1" sc="$2"
  local f="$OUT/${ph}__${sc}.png"
  agent-browser screenshot "$f" >/dev/null 2>&1
  local ec; ec=$(console_errs)
  record "$ph" "$sc" "$f" "${ec%%|*}" "${ec#*|}"
  echo "    📷 $ph/$sc (console-errors: ${ec%%|*})"
}

apply_override() { # var palette dir [angle]
  local var="$1" pal="$2" dir="$3" ang="${4:-}"
  local a=""; [ -n "$ang" ] && a=", angle: $ang"
  ev "Settings.setState({themeOverrides:{'$THEME':{'$var':{colors:$pal,dir:'$dir'$a}}}})" >/dev/null
}

wait_for() { # js-condition max-seconds — poll until true
  local cond="$1" max="${2:-10}"
  for _ in $(seq 1 $((max * 2))); do
    local r; r=$(ev "$cond" 2>/dev/null)
    [ "$r" = "true" ] || [ "$r" = "1" ] && return 0
    sleep 0.5
  done
  return 1
}

phase_invariants() { # phase var
  local ph="$1" var="$2"
  local inv
  inv=$(ev "(function(){
    var cs=getComputedStyle(document.documentElement);
    var g=cs.getPropertyValue('$var-gradient').trim();
    var s=cs.getPropertyValue('$var').trim();
    var att=function(sel){var el=document.querySelector(sel);return el?getComputedStyle(el).backgroundAttachment:'';};
    var img=function(sel){var el=document.querySelector(sel);return el?String(getComputedStyle(el).backgroundImage).slice(0,90):'';};
    return JSON.stringify({solid:s,grad:g.slice(0,140),textGrad:document.documentElement.getAttribute('data-text-grad')||'',veilInk:cs.getPropertyValue('--veil-ink').trim(),onAcc:cs.getPropertyValue('--on-accent').trim()+'/'+cs.getPropertyValue('--on-accent-2').trim()+'/'+cs.getPropertyValue('--on-accent-3').trim()+'/'+cs.getPropertyValue('--on-accent-4').trim(),meta:(document.getElementById('meta-theme-color')||{}).content||'',proj:{panel:att('#chat-panel'),header:att('#chat-header'),pillS:att('#pill-sandbox'),pillM:att('#pill-model'),pillImg:(img('#pill-sandbox')+' | '+img('#pill-model')).slice(0,180)}});
  })()")
  echo "{\"kind\":\"invariants\",\"phase\":\"$ph\",\"var\":\"$var\",\"checks\":$inv}" >> "$OUT/manifest.ndjson"
  echo "    ✔ invariants $ph/$var: $inv" | head -c 260; echo
}

nav() { # screen — navigate + leave the screen ready for a shot
  local sc="$1"
  case "$sc" in
    home)
      ab reload; sleep 1.9 ;;
    chat|chat-code|tweaks)
      ab reload; sleep 1.9
      ab mouse move 120 200; ab mouse down; ab mouse up; sleep 2.5
      if [ "$sc" = "chat-code" ]; then
        ev "var m=document.getElementById('chat-messages')||document.querySelector('.chat-body,#chat-panel .panel-body');if(m){m.scrollTop=m.scrollHeight;}" >/dev/null; sleep 0.5
      fi
      if [ "$sc" = "tweaks" ]; then
        ev "var b=[].slice.call(document.querySelectorAll('.util-btn')).filter(function(b){return b.textContent.indexOf('✦')>=0;})[0];if(b){b.scrollIntoView({block:'center'});b.click();}" >/dev/null; sleep 1.0
      fi ;;
    colors|colors-editor|sizing|general)
      ab reload; sleep 1.9
      ev "document.getElementById('settings-btn').click()" >/dev/null; sleep 1.0
      if [ "$sc" = "colors-editor" ]; then
        # the Customize section itself starts COLLAPSED — open it, then the row
        ev "var hs=[].slice.call(document.querySelectorAll('.settings-section h3'));var h=hs.filter(function(x){return /Customize/.test(x.textContent)})[0];if(h)h.click();" >/dev/null; sleep 0.5
        ev "var t=document.querySelector('[data-color-toggle]');if(t)t.click();" >/dev/null; sleep 0.8
      elif [ "$sc" = "sizing" ]; then
        ev "var t=document.querySelector('.settings-nav .tab[data-page=\"sizing\"]');if(t)t.click();" >/dev/null; sleep 0.6
      elif [ "$sc" = "general" ]; then
        ev "var t=document.querySelector('.settings-nav .tab[data-page=\"general\"]');if(t)t.click();" >/dev/null; sleep 0.6
      fi ;;
    providers)
      ab reload; sleep 1.9
      ev "window.ProvidersScreen.open(null,{})" >/dev/null; sleep 1.7 ;;
    models)
      ab reload; sleep 1.9
      ev "window.ModelBrowser.open(null,{})" >/dev/null; sleep 1.5 ;;
    sandbox)
      ab reload; sleep 1.9
      ev "window.SandboxPicker.open(null)" >/dev/null; sleep 1.8 ;;
    modelpill)
      ab reload; sleep 1.9
      ev "window.ModelPicker.open(null)" >/dev/null; sleep 0.9 ;;
    workspaces|connect)
      ab reload; sleep 1.9
      ev "window.Workspace.openPicker(null,null)" >/dev/null; sleep 2.0
      if [ "$sc" = "connect" ]; then
        ev "var c=document.querySelector('.wsx-conn,[class*=wsx-conn]');if(c)c.click();else{var r=[].slice.call(document.querySelectorAll('[class*=wsx]')).filter(function(e){return /connect/i.test(e.textContent)})[0];if(r)r.click();}" >/dev/null; sleep 1.4
      fi ;;
    library|bunch|item)
      ab reload; sleep 1.9
      ev "document.getElementById('dock-library').click()" >/dev/null
      # the hub view loads async (engine corpus) — wait for the root
      wait_for "!!document.querySelector('.hub-root')" 10 || sleep 3
      # switch to the SKILL library (the default persona lib is empty; the
      # skills carry the bunch card + item cards for the theme screens)
      ev "window.Hub.open('skill')" >/dev/null
      wait_for "document.querySelectorAll('.hub-card').length >= 1" 10 || sleep 3
      if [ "$sc" = "bunch" ] || [ "$sc" = "item" ]; then
        ev "var c=document.querySelector('.hub-card');if(c)c.click();" >/dev/null
        wait_for "document.querySelectorAll('.hub-card').length > 1" 10 || sleep 3
      fi
      if [ "$sc" = "item" ]; then
        ev "var cs=document.querySelectorAll('.hub-card');if(cs.length>3){cs[3].click();}else if(cs.length){cs[0].click();}" >/dev/null; sleep 1.7
      fi ;;
    chatsview)
      ab reload; sleep 1.9
      ev "window.ChatsView.open()" >/dev/null; sleep 1.4 ;;
    search)
      ab reload; sleep 1.9
      ev "window.GlobalSearch.open()" >/dev/null; sleep 0.7 ;;
    shortcuts)
      ab reload; sleep 1.9
      ev "window.Keys.openShortcuts()" >/dev/null; sleep 0.7 ;;
  esac
}

run_phase_screens() { # phase screens...
  local ph="$1"; shift
  local sc
  for sc in "$@"; do
    if [ -n "$SCREENS_FILTER" ]; then
      case " $SCREENS_FILTER " in *" $sc "*) ;; *) continue;; esac
    fi
    nav "$sc"
    shot "$ph" "$sc"
  done
}

phase_allowed() { # phase-id
  [ -z "$PHASES_FILTER" ] && return 0
  case " $PHASES_FILTER " in *" $1 "*) return 0;; *) return 1;; esac
}

# ── boot the engine (fresh data dir + the connected keys) ────────
# The keys come from the ENVIRONMENT (never baked into the repo — GitHub
# push protection rejects secret literals). Export before launching:
#   DOOMALAY_HF_TOKEN=… PRIVATEMODEAI_API_KEY=… GITHUB_PAT=… \
#     bash scripts/v065-theme-suite.sh [seed]
pkill -f "doomalay-engine.*$PORT" 2>/dev/null; sleep 0.5
rm -rf "$DATA"; mkdir -p "$DATA"
echo "brain_dir: $DATA/no-brain" > "$DATA/nobrain.yaml"
export DOOMALAY_HF_TOKEN="${DOOMALAY_HF_TOKEN:-}"
export HUGGING_FACE_TOKEN="${HUGGING_FACE_TOKEN:-$DOOMALAY_HF_TOKEN}"
export PRIVATEMODEAI_API_KEY="${PRIVATEMODEAI_API_KEY:-}"
export GITHUB_PAT="${GITHUB_PAT:-}"
[ -z "$DOOMALAY_HF_TOKEN" ] && echo "  (no DOOMALAY_HF_TOKEN — the sandbox screen shows the logged-out state)"
[ -z "$GITHUB_PAT" ] && echo "  (no GITHUB_PAT — the workspaces repos box stays empty)"
"$ENG" -open=false -port=$PORT -data-dir="$DATA" -config="$DATA/nobrain.yaml" >"$OUT/engine.log" 2>&1 &
ENGPID=$!
cleanup() {
  if [ "$KEEP" = "0" ]; then kill $ENGPID 2>/dev/null; wait 2>/dev/null; fi
  agent-browser close 2>/dev/null
}
trap cleanup EXIT
for i in $(seq 1 120); do curl -s "$BASE/api/health" >/dev/null 2>&1 && break; sleep 0.25; done
curl -s "$BASE/api/health" >/dev/null 2>&1 && echo "✔ engine up (pid $ENGPID)" || { echo "✘ engine failed to boot"; tail -5 "$OUT/engine.log"; exit 1; }

# ── a real session + rich markdown (the formatter slots) ──────────
SID=$(curl -s -X POST "$BASE/api/sessions" -H 'Content-Type: application/json' \
  -d '{"title":"Theme Bot","sandbox":"quick","model":"nvidia/mock/alive-a","provider":"nvidia"}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["ID"])')
echo "✔ session $SID"
python3 - "$BASE" "$SID" <<'PYEOF'
import json, sys, urllib.request
base, sid = sys.argv[1], sys.argv[2]
msgs = [
  ("user", "Check this theme — show me colors with markdown"),
  ("assistant", "# Theme Gradient Report\n\nThe **theme engine** follows *every* color now, including the pills.\n\n## The slots\n- a1 rides headings\n- a2 rides subheads and code\n\n> quoted text rides a3\n\nA [real link](https://example.com/theme) rides the link slot, and **bright bold** text rides the bright slot.\n\n```python\ndef twins(spec):\n    # a2 rides code blocks\n    return spec.colors[:6]\n```\n"),
  ("user", "How do the pills look?"),
  ("assistant", "Every pill samples the **surface field window**:\n\n1. the model pill\n2. the sandbox pill\n3. the workspace pill\n\nPlus `inline code`, ~~strike~~ and more *bright* text with an [example](https://example.org) link.\n"),
  ("status", "{\"state\":\"idle\"}"),
]
for t, txt in msgs:
    req = urllib.request.Request(base + "/api/sessions/" + sid + "/events",
        data=json.dumps({"type": t, "text": txt}).encode(), headers={"Content-Type": "application/json"})
    urllib.request.urlopen(req)
print("✔ messages appended")
PYEOF

# ── boot the browser + seed the canvas icon ──────────────────────
agent-browser set viewport 412 915 >/dev/null 2>&1
agent-browser open "$BASE" >/dev/null 2>&1; sleep 1.6
agent-browser errors --clear >/dev/null 2>&1
agent-browser eval "localStorage.setItem('doomalay.state.v2', JSON.stringify({offset:{x:0,y:0},scale:1,currentFamily:'nvidia',icons:[{id:'f1',type:'chat',name:'Theme Bot',family:'nvidia',iconIndex:0,x:120,y:200,vx:0,vy:0,radius:28,sandbox:'quick',model:'nvidia/mock/alive-a',provider:'nvidia',sessionId:'$SID'}],savedAt:Date.now()}))" >/dev/null
agent-browser eval "localStorage.setItem('doomalay.settings.v1', JSON.stringify({theme:'$THEME',themeOverrides:{},chatScheme:'teal',fmtOverrides:{}}))" >/dev/null
agent-browser reload >/dev/null 2>&1; sleep 1.9
echo "✔ browser ready (theme $THEME)"

# ═══ THE PHASES ═══
echo "{\"kind\":\"meta\",\"seed\":$SEED,\"theme\":\"$THEME\",\"port\":$PORT}" >> "$OUT/manifest.ndjson"

# p00 — the pristine random theme
if phase_allowed p00; then
  echo "── p00 base ($THEME)"
  run_phase_screens p00 home chat
  phase_invariants p00 --accent
fi

# p01..p10 — one var per phase, 5-6 color gradients, every screen
run_var_phase() { # phaseid var palette dir angle label
  local ph="$1" var="$2" pal="$3" dir="$4" ang="$5" label="$6"
  phase_allowed "$ph" || return 0
  echo "── $ph $label ($dir, 6 colors)"
  apply_override "$var" "$pal" "$dir" "$ang"
  sleep 0.4
  phase_invariants "$ph" "$var"
  run_phase_screens "$ph" $ALL_SCREENS
}
run_var_phase p01 --bg-panel   "$P_CANVAS"  mesh  ""   "canvas background"
run_var_phase p02 --bg-app     "$P_OVERLAY" mesh  ""   "overlay background"
run_var_phase p03 --surface-1  "$P_SURF1"   diag  ""   "surface"
run_var_phase p04 --surface-2  "$P_SURF2"   diag2 ""   "surface raised"
run_var_phase p05 --border     "$P_BORDER"  diag  45   "borders"
run_var_phase p06 --text-1     "$P_TEXT_D"  mesh  ""   "primary text (dark-first)"
run_var_phase p07 --accent     "$P_ACC1"    mesh  ""   "accent 1"
run_var_phase p08 --accent-2   "$P_ACC2"    diag  ""   "accent 2"
run_var_phase p09 --accent-3   "$P_ACC3"    mesh  ""   "accent 3"
run_var_phase p10 --accent-4   "$P_ACC4"    diag2 ""   "accent 4"

# p11 — primary text, LIGHT-first gradient (the other veil direction)
if phase_allowed p11; then
  echo "── p11 primary text (light-first)"
  apply_override --text-1 "$P_TEXT_L" mesh
  sleep 0.4; phase_invariants p11 --text-1
  run_phase_screens p11 home chat tweaks colors colors-editor library workspaces connect bunch item
fi

# p12 — ALL chat markdown schemes
if phase_allowed p12; then
  echo "── p12 chat schemes (10)"
  for sch in teal sunset forest berry ocean rose mono solar paper frost; do
    ev "Settings.setState({chatScheme:'$sch',fmtOverrides:{},themeOverrides:{}})" >/dev/null
    nav chat
    shot "p12-$sch" chat
  done
fi

# p13 — the 5 chat color slots as gradients
if phase_allowed p13; then
  echo "── p13 chat fmt slots (gradient overrides)"
  ev "Settings.setState({fmtOverrides:{a1:{colors:$P_FMT_A1,dir:'mesh'},a2:{colors:$P_FMT_A2,dir:'diag'},a3:{colors:$P_FMT_A3,dir:'mesh'},bright:{colors:$P_FMT_BR,dir:'diag2'},link:{colors:$P_FMT_LK,dir:'mesh'}}})" >/dev/null
  sleep 0.4
  echo "{\"kind\":\"invariants\",\"phase\":\"p13\",\"var\":\"fmt\",\"checks\":$(ev "(function(){var cs=getComputedStyle(document.documentElement);return JSON.stringify({a1:cs.getPropertyValue('--fmt-a1-gradient').trim().slice(0,80),link:cs.getPropertyValue('--fmt-link-gradient').trim().slice(0,80)});})()")}" >> "$OUT/manifest.ndjson"
  run_phase_screens p13 chat chat-code tweaks
fi

# p14 — grid colors as gradients (lines / dots / origin)
if phase_allowed p14; then
  echo "── p14 grid gradients"
  ev "Settings.setState({lineColor:{colors:$P_GRID_L,dir:'mesh'},dotColor:{colors:$P_GRID_L,dir:'diag'},originColor:{colors:$P_GRID_L,dir:'diag2'}})" >/dev/null
  sleep 0.6
  run_phase_screens p14 home
  ev "Settings.setState({lineColor:'#131318',dotColor:'#2e2e3a',originColor:'#4a4a5e'})" >/dev/null
fi

# p15 — THE COMBO: everything gradiented at once
if phase_allowed p15; then
  echo "── p15 combo (all 10 vars + grid + fmt)"
  ev "Settings.setState({themeOverrides:{'$THEME':{'--bg-panel':{colors:$P_CANVAS,dir:'mesh'},'--bg-app':{colors:$P_OVERLAY,dir:'mesh'},'--surface-1':{colors:$P_SURF1,dir:'diag'},'--surface-2':{colors:$P_SURF2,dir:'diag2'},'--border':{colors:$P_BORDER,dir:'diag',angle:45},'--text-1':{colors:$P_TEXT_D,dir:'mesh'},'--accent':{colors:$P_ACC1,dir:'mesh'},'--accent-2':{colors:$P_ACC2,dir:'diag'},'--accent-3':{colors:$P_ACC3,dir:'mesh'},'--accent-4':{colors:$P_ACC4,dir:'diag2'}}},lineColor:{colors:$P_GRID_L,dir:'mesh'},dotColor:{colors:$P_GRID_L,dir:'diag'},originColor:{colors:$P_GRID_L,dir:'diag2'},fmtOverrides:{a1:{colors:$P_FMT_A1,dir:'mesh'},a2:{colors:$P_FMT_A2,dir:'diag'},a3:{colors:$P_FMT_A3,dir:'mesh'},bright:{colors:$P_FMT_BR,dir:'diag2'},link:{colors:$P_FMT_LK,dir:'mesh'}}})" >/dev/null
  sleep 0.6
  phase_invariants p15 --text-1
  run_phase_screens p15 $ALL_SCREENS
fi

# p16 — revert: back to the pristine theme
if phase_allowed p16; then
  echo "── p16 revert"
  ev "Settings.setState({themeOverrides:{},fmtOverrides:{},chatScheme:'teal',lineColor:'#131318',dotColor:'#2e2e3a',originColor:'#4a4a5e'})" >/dev/null
  sleep 0.6
  phase_invariants p16 --accent
  run_phase_screens p16 home chat colors
fi

# p17 — v0.66 THE WINDOW PROOF: a hard RED-left/BLUE-right accent-1 split.
#     Every accent-1 object (the sandbox + persona pills, the user bubble,
#     the lib pill) is a WINDOW into the SAME viewport projection: left
#     pills must read RED-ish, right pills BLUE-ish (the audit's
#     cross-element check), and NO pill may be white/milky (the
#     stained-white regression this wave buries).
if phase_allowed p17; then
  echo "── p17 the window proof (accent-1 hard split)"
  apply_override --accent "['#ff0033','#ff0033','#0044ff','#0044ff']" h
  sleep 0.4
  phase_invariants p17 --accent
  run_phase_screens p17 chat colors library tweaks
  ev "Settings.setState({themeOverrides:{}})" >/dev/null
  sleep 0.4
fi

# p18 — v0.66 THE PILL VIEW: the header dropdown EXPANDED so the pill row
#     is VISIBLE (sandbox/model/artifacts/persona/mind + the util row),
#     under the accent-1 hard split + an accent-2 diag — every pill is a
#     window into ITS variable's projection (the p17 proof, pill edition:
#     left pills red, right pills blue, model/artifacts show a2's diag).
if phase_allowed p18; then
  echo "── p18 the pill view (dropdown expanded, a1 split + a2 diag)"
  ev "Settings.setState({themeOverrides:{'$THEME':{'--accent':{colors:['#ff0033','#ff0033','#0044ff','#0044ff'],dir:'h'},'--accent-2':{colors:['#8a2be2','#c71585','#ff1493','#ff6347','#ffa500','#f5f542'],dir:'diag'}}}})" >/dev/null
  sleep 0.4
  phase_invariants p18 --accent
  nav chat
  ev "var ch=document.getElementById('header-chevron'); if(ch) ch.click();" >/dev/null
  sleep 0.6
  shot p18 chat-pills
  nav colors
  shot p18 colors
  ev "Settings.setState({themeOverrides:{}})" >/dev/null
  sleep 0.4
fi

# ── assemble the manifest ────────────────────────────────────────
python3 - "$OUT" "$SEED" "$THEME" <<'PYEOF'
import json, sys, os
out, seed, theme = sys.argv[1], sys.argv[2], sys.argv[3]
rows = []
for line in open(os.path.join(out, 'manifest.ndjson'), encoding='utf-8'):
    line = line.strip()
    if line:
        try: rows.append(json.loads(line))
        except Exception as e: print('manifest parse skip:', e)
meta = [r for r in rows if r.get('kind') == 'meta']
invs  = [r for r in rows if r.get('kind') == 'invariants']
shots = [r for r in rows if 'screen' in r]
shots.sort(key=lambda r: (r['phase'], r['screen']))
manifest = {
    'seed': int(seed), 'theme': theme,
    'shots': len(shots),
    'console_error_screens': [f"{r['phase']}/{r['screen']} ({r['errs']})" for r in shots if r.get('errs')],
    'phases': sorted({r['phase'] for r in shots}),
    'screens': sorted({r['screen'] for r in shots}),
    'invariants': invs,
    'records': shots,
}
with open(os.path.join(out, 'manifest.json'), 'w', encoding='utf-8') as f:
    json.dump(manifest, f, indent=1, ensure_ascii=False)
print('manifest: %d shots, %d phases, %d invariants' % (len(shots), len(manifest['phases']), len(invs)))
if manifest['console_error_screens']:
    print('CONSOLE ERRORS ON:')
    for s in manifest['console_error_screens']: print('  -', s)
PYEOF

echo "═══ SUITE DONE ═══  screenshots: $(ls "$OUT"/*.png 2>/dev/null | wc -l)  → $OUT"
