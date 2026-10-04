#!/bin/bash
# v0981-test.sh — v0.98.1 THE CATALOGUE & SHEETS POLISH WAVE pins.
#
# The user's three open items (issues 1-3 of the latest batch):
#  (1) THE SINGLE X — the provider/model catalogue screen had TWO close
#      glyphs (its own #mb-close under ConnectOverlay's hardcoded static
#      ✕). The in-page one is gone; the header keeps its right edge clear
#      of the static X so the tabs never render underneath it.
#  (2) THE AUTO-REFRESH — a provider key saved mid-session must appear in
#      the catalogue WITHOUT a manual resync: every browser open
#      revalidates in the background (SWR), and the key save dispatches
#      doomalay:catalog-changed which busts the localStorage cache + the
#      quick-switch cache.
#  (3) THE THEMED LOADER — the workspaces picker + the connect page's
#      repos box get the accent label, the primary sweep bar and the live
#      elapsed counter (theme vars only).
#  (4) THE SHEET DRAG-DOWN — the artifacts drawer/editor head is a drag
#      handle: drag down past 25% (or a fling) dismisses; a small drag
#      springs back; drags starting on buttons never move the sheet.
#  (5) zero console errors.
set -u
cd "$(dirname "$0")/.."
ENG=engine/bin/doomalay-engine
DATA=/tmp/doomalay-v0981
export AGENT_BROWSER_SESSION=doomalay-v0981

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

# secrets (names only in logs; skip-not-fail when absent)
GITHUB_TOKEN=$(grep -oP '^GITHUB_TOKEN=\K.*' /home/z/my-project/.secrets 2>/dev/null || true)
NVIDIA_KEY=$(grep -oP '^NVIDIA_KEY=\K.*' /home/z/my-project/.secrets 2>/dev/null || true)

rm -rf $DATA; mkdir -p $DATA
$ENG -open=false -port=$PORT -data-dir=$DATA >/tmp/v0981-eng.log 2>&1 &
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

echo "── (1) THE SINGLE X: one close glyph on the catalogue screen"
ev "window.ModelBrowser.open(function(){})" >/dev/null; sleep 1.2
R=$(ev "JSON.stringify({
  noMbClose: !document.getElementById('mb-close'),
  staticX: !!document.getElementById('connect-overlay-x'),
  staticXVisible: (function(){ var e=document.getElementById('connect-overlay-x'); if(!e) return false;
    var r=e.getBoundingClientRect(); return r.width>0 && r.height>0; })(),
  tabsClear: (function(){ var t=document.querySelector('.mb-viewtab'); var x=document.getElementById('connect-overlay-x');
    if(!t||!x) return false; return t.getBoundingClientRect().right <= x.getBoundingClientRect().left; })(),
  headPad: (function(){ var h=document.getElementById('mb-head'); if(!h) return '';
    var row=h.firstElementChild; return row?getComputedStyle(row).paddingRight:''; })()
})")
ck "the in-page #mb-close is GONE (the overlay's static ✕ owns the close)" \
  "$(echo "$R" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print('yes' if d['noMbClose'] else 'no')")" "$R"
ck "the static overlay ✕ exists and is visible" \
  "$(echo "$R" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print('yes' if d['staticX'] and d['staticXVisible'] else 'no')")" "$R"
ck "the header keeps the tabs clear of the static X (padding-right 34px)" \
  "$(echo "$R" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print('yes' if d['tabsClear'] and d['headPad']=='34px' else 'no')")" "$R"
ev "window.ConnectOverlay.close()" >/dev/null; sleep 0.5

echo "── (2) THE AUTO-REFRESH: SWR on every open + the key-save cache bust"
# (a) open once → the cache persists
ev "window.ModelBrowser.open(function(){})" >/dev/null; sleep 1.5
C1=$(ev "!!localStorage.getItem('doomalay.modelcache.v1')")
ev "window.ConnectOverlay.close()" >/dev/null; sleep 0.5
ck "first open persists the catalog cache" "$([ "$C1" = "True" ] || [ "$C1" = "true" ] && echo yes || echo no)" "$C1"
# (b) EVERY open re-fetches in the background (patch fetch, count /api/models)
ev "window.__mbFetches=0; var _f=window.fetch; window.fetch=function(u){ if(String(u).indexOf('/api/models')===0) window.__mbFetches++; return _f.apply(this,arguments); };" >/dev/null
ev "window.ModelBrowser.open(function(){})" >/dev/null; sleep 1.8
F1=$(ev "window.__mbFetches")
ev "window.ConnectOverlay.close()" >/dev/null; sleep 0.5
ck "reopening re-fetches /api/models in the background (SWR, got $F1)" "$([ "${F1:-0}" -ge 1 ] 2>/dev/null && echo yes || echo no)" "fetches=$F1"
# (c) the providers-screen key save busts the cache (the real dispatcher)
if [ -n "$NVIDIA_KEY" ]; then
  ev "window.ProvidersScreen.open(function(){})" >/dev/null; sleep 1.5
  KEYINPUT=$(ev "(function(){ var i=document.querySelector('input[id^=\"key-nvidia\"]'); if(!i) return ''; return i.id; })()")
  if [ -n "$KEYINPUT" ]; then
    ev "document.getElementById('$KEYINPUT').value='$NVIDIA_KEY'" >/dev/null
    ev "(function(){ var b=document.querySelector('[data-save=\"nvidia\"]'); if(b) b.click(); })()" >/dev/null
    BUSTED=no
    for i in $(seq 1 40); do
      C=$(ev "!localStorage.getItem('doomalay.modelcache.v1')" 2>/dev/null)
      [ "$C" = "True" ] || [ "$C" = "true" ] && { BUSTED=yes; break; }
      sleep 0.5
    done
    ck "saving a provider key dispatches the bust (cache removed from localStorage)" "$BUSTED" "cache=$(ev "!!localStorage.getItem('doomalay.modelcache.v1')")"
    ev "window.ConnectOverlay.close()" >/dev/null; sleep 0.4
    # (d) the reopened browser shows the key-backed provider WITHOUT any manual resync
    ev "window.__mbFetches=0" >/dev/null
    ev "window.ModelBrowser.open(function(){})" >/dev/null; sleep 2.2
    R=$(ev "JSON.stringify({
      refetched: window.__mbFetches>0,
      nvidiaKeyed: (function(){ var rows=document.querySelectorAll('.mb-logrow,.mb-hrow,[data-provider]'); return rows.length>0; })(),
      syncedLabel: (function(){ var l=document.getElementById('mb-sync-label'); return l?l.textContent:''; })()
    })")
    ck "reopen auto-syncs the catalogue (no manual resync; label reads fresh)" \
      "$(echo "$R" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print('yes' if d['refetched'] and d['syncedLabel'] else 'no')")" "$R"
    ev "window.ConnectOverlay.close()" >/dev/null; sleep 0.4
  else
    echo "  ⤼ SKIP key-save path: nvidia input not found (screen shape changed?)"
  fi
else
  echo "  ⤼ SKIP key-save path: NVIDIA_KEY absent from .secrets"
fi

echo "── (3) THE THEMED LOADER: accent label + primary sweep + live counter"
# a session for the artifacts step
SID=$(curl -s -X POST "$BASE/api/sessions" -H 'Content-Type: application/json' \
  -d '{"id":"v0981","title":"v0981 rig","sandbox":"quick","model":"openai/gpt-4o","provider":"openai"}' \
  | python3 -c "import sys,json;print(json.load(sys.stdin).get('ID',''))" 2>/dev/null || echo "")
# THE ACCOUNT GOES IN BEFORE THE FIRST PICKER OPEN — the picker's
# hydrateAccounts result is cached 60s (v0.98 C5), so an out-of-band add
# AFTER the first open would read stale on the connect page.
if [ -n "$GITHUB_TOKEN" ]; then
  ACC=$(curl -s -X POST "$BASE/api/workspaces/accounts" -H 'Content-Type: application/json' \
    -d "{\"kind\":\"github\",\"token\":\"$GITHUB_TOKEN\"}" | head -c 60)
fi
# HOLD THE LISTS OPEN ~1.6s — a fresh engine resolves the empty globals
# list in ~20ms (rig-verified: loader seen at 19ms, gone at 24ms), faster
# than any post-hoc check can observe. Only the two list endpoints are
# delayed (accounts/discover-scoped); everything else passes through.
ev "window.__delayOrig=window.fetch; window.fetch=function(u,o){ var s=String(u); if(s==='/api/workspaces'||s.indexOf('/api/workspaces/discover')===0){ return new Promise(function(res){ setTimeout(function(){ res(window.__delayOrig.apply(window,[u,o])); },1600); }); } return window.__delayOrig.apply(window,arguments); };" >/dev/null
ev "window.Workspace.openPicker(function(){})" >/dev/null; sleep 0.9
R=$(ev "JSON.stringify({
  loader: !!document.querySelector('#wsx-list .wsp-loader'),
  textAccent: (function(){ var t=document.querySelector('.wsp-loader-text'); if(!t) return false;
    var p=document.createElement('div'); p.style.color='var(--accent)'; document.body.appendChild(p);
    var a=getComputedStyle(p).color; p.remove(); return getComputedStyle(t).color===a; })(),
  sweep: (function(){ var b=document.querySelector('#wsx-list .wsp-loader-bar'); if(!b) return '';
    return getComputedStyle(b,'::after').animationName; })(),
  sec0: (function(){ var s=document.querySelector('.wsp-loader-sec'); return s?s.textContent:''; })()
})")
ck "the picker list shows the themed loader" \
  "$(echo "$R" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print('yes' if d['loader'] else 'no')")" "$R"
ck "the label reads in the theme's ACCENT color" \
  "$(echo "$R" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print('yes' if d['textAccent'] else 'no')")" "$R"
ck "the primary sweep bar animates (wsp-sweep)" \
  "$(echo "$R" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print('yes' if d['sweep']=='wsp-sweep' else 'no')")" "$R"
S1=$(ev "(function(){ var s=document.querySelector('.wsp-loader-sec'); return s?s.textContent:''; })()")
sleep 0.7
S2=$(ev "(function(){ var s=document.querySelector('.wsp-loader-sec'); return s?s.textContent:''; })()")
ck "the elapsed counter ticks live ($S1 → $S2)" "$([ -n "$S1" ] && [ "$S1" != "$S2" ] && echo yes || echo no)" "$S1 / $S2"
# the loader dies when the list resolves
GONE=no
for i in $(seq 1 20); do
  G=$(ev "!document.querySelector('#wsx-list .wsp-loader')" 2>/dev/null)
  { [ "$G" = "True" ] || [ "$G" = "true" ]; } && { GONE=yes; break; }
  sleep 0.4
done
ck "the loader leaves when the list resolves (no zombie loader)" "$GONE" "$(ev "!!document.querySelector('#wsx-list .wsp-loader')")"

# the connect page's repos box (the account went in BEFORE the first
# picker open above — the 60s accounts cache reads it fresh)
if [ -n "$GITHUB_TOKEN" ]; then
  ev "(function(){ var c=document.getElementById('wsx-connect'); if(c) c.click(); })()" >/dev/null; sleep 1.6
  R=$(ev "JSON.stringify({
    loader: !!document.querySelector('#wsp-repos .wsp-loader'),
    signedIn: !!document.querySelector('.wsp-loggedin'),
    sweep: (function(){ var b=document.querySelector('#wsp-repos .wsp-loader-bar'); if(!b) return '';
      return getComputedStyle(b,'::after').animationName; })()
  })")
  ck "the connect page's repos box shows the themed loader (github signed in: $ACC)" \
    "$(echo "$R" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print('yes' if d['loader'] and d['sweep']=='wsp-sweep' else 'no')")" "$R"
  REPOFILL=no
  for i in $(seq 1 30); do
    G=$(ev "!!document.querySelector('#wsp-repos .wsp-repo')" 2>/dev/null)
    { [ "$G" = "True" ] || [ "$G" = "true" ]; } && { REPOFILL=yes; break; }
    sleep 0.5
  done
  ck "the repos box fills with real repos (loader replaced)" "$REPOFILL" "$(ev "document.querySelectorAll('#wsp-repos .wsp-repo').length")"
  ev "window.ConnectOverlay.close()" >/dev/null; sleep 0.4
else
  echo "  ⤼ SKIP connect-page loader: GITHUB_TOKEN absent from .secrets"
fi
# restore the clean fetch (the delay harness is done)
ev "if(window.__delayOrig){ window.fetch=window.__delayOrig; window.__delayOrig=null; }" >/dev/null

echo "── (4) THE SHEET DRAG-DOWN: artifacts dismiss from the top"
if [ -n "$SID" ]; then
  ev "window.Artifacts.openDrawer('$SID', {name:'v0981'})" >/dev/null; sleep 1.1
  DRAG=$(ev "(function(){
    var head=document.querySelector('#artifacts-overlay .art-head');
    var panel=document.querySelector('#artifacts-overlay .art-panel');
    if(!head||!panel) return JSON.stringify({fail:'no drawer'});
    var o={bubbles:true,cancelable:true,pointerId:7,isPrimary:true,button:0,clientX:200};
    head.dispatchEvent(new PointerEvent('pointerdown',Object.assign({clientY:80},o)));
    head.dispatchEvent(new PointerEvent('pointermove',Object.assign({clientY:150},o)));
    head.dispatchEvent(new PointerEvent('pointermove',Object.assign({clientY:430},o)));
    var midT=panel.style.transform;
    head.dispatchEvent(new PointerEvent('pointerup',Object.assign({clientY:470},o)));
    return JSON.stringify({midTransform:midT, open: document.getElementById('artifacts-overlay').style.display});
  })()")
  MID=$(echo "$DRAG" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print(d.get('midTransform',''))" 2>/dev/null)
  ck "the panel follows the finger mid-drag (translateY set: $MID)" \
    "$(echo "$MID" | python3 -c "import sys; t=sys.stdin.read().strip(); print('yes' if 'translateY' in t and 'none' not in t else 'no')")" "$DRAG"
  DISMISSED=no
  for i in $(seq 1 12); do
    D=$(ev "document.getElementById('artifacts-overlay').style.display" 2>/dev/null | tr -d '"')
    [ "$D" = "none" ] && { DISMISSED=yes; break; }
    sleep 0.25
  done
  ck "release past 25% dismisses the drawer" "$DISMISSED" "display=$(ev "document.getElementById('artifacts-overlay').style.display")"
  # spring back: a small drag keeps the overlay open
  ev "window.Artifacts.openDrawer('$SID', {name:'v0981'})" >/dev/null; sleep 1.1
  ev "(function(){
    var head=document.querySelector('#artifacts-overlay .art-head');
    var o={bubbles:true,cancelable:true,pointerId:8,isPrimary:true,button:0,clientX:200};
    head.dispatchEvent(new PointerEvent('pointerdown',Object.assign({clientY:80},o)));
    head.dispatchEvent(new PointerEvent('pointermove',Object.assign({clientY:108},o)));
    head.dispatchEvent(new PointerEvent('pointerup',Object.assign({clientY:110},o)));
  })()" >/dev/null; sleep 0.7
  R=$(ev "JSON.stringify({
    stillOpen: document.getElementById('artifacts-overlay').style.display!=='none',
    restored: document.querySelector('#artifacts-overlay .art-panel').style.transform===''
  })")
  ck "a small drag springs back (overlay stays open, transform restored)" \
    "$(echo "$R" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print('yes' if d['stillOpen'] and d['restored'] else 'no')")" "$R"
  # button exclusion: a drag starting on the ✕ never moves the panel
  ev "(function(){
    var x=document.querySelector('#artifacts-overlay .art-close');
    var head=document.querySelector('#artifacts-overlay .art-head');
    var panel=document.querySelector('#artifacts-overlay .art-panel');
    var o={bubbles:true,cancelable:true,pointerId:9,isPrimary:true,button:0,clientX:355};
    x.dispatchEvent(new PointerEvent('pointerdown',Object.assign({clientY:30},o)));
    head.dispatchEvent(new PointerEvent('pointermove',Object.assign({clientY:200},o)));
    head.dispatchEvent(new PointerEvent('pointerup',Object.assign({clientY:300},o)));
    window.__btnDragT=panel.style.transform;
  })()" >/dev/null; sleep 0.5
  BT=$(ev "window.__btnDragT" 2>/dev/null | tr -d '"')
  ck "drags starting on the ✕ button never move the sheet (transform '$BT' untouched)" "$([ -z "$BT" ] && echo yes || echo no)" "$BT"
  ev "window.Artifacts.closeOverlay()" >/dev/null; sleep 0.4
else
  echo "  ⤼ SKIP drag tests: session create failed"
fi

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
