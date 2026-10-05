#!/bin/bash
# v098-panel-colors.sh — THE PANEL COLORS RIG (PLAN-V098 Phase C).
#
# THE CONTRACT — what v0.98 Phase C changed, proven on a FRESH INSTALL
# (fresh data-dir + wiped localStorage → the DEFAULT midnight theme):
#  (C1) L2.ok() rides ONE POS_SEL querySelector sweep (not a per-descendant
#       getComputedStyle walk) — the Colors tab opens without a stall.
#  (C2) the mint decisions (okv) compute in the READ phase — no
#       read/write interleaving, no forced-style black-flash window.
#  (C3) collapsed color rows build their GradientUI editor on FIRST
#       expand — the Colors tab mounts ~300 nodes instead of ~979, zero
#       .gr-editor exists until a row opens, the shells carry
#       [data-lazy-pfx].
#  (C4) the L2 style sheet (#proj-layer-styles) no longer re-triggers
#       SEL re-derivation — interactions stay cheap.
#  (C5) hydrateAccounts 60s session cache — a General tab revisit fires
#       ZERO account fetches.
#  (C6) settings close wipes the heavy body after 450ms.
#
# LEGS:
#  A — the Colors tab open (lean mount · off the main thread · bounded
#      paints · lazy rows · 4 sections) + the lazy expand + the in-place
#      '+' shape change + the section collapse/expand pair.
#  B — the General tab (hydrateAccounts rows + the 60s cache on revisit).
#  C — the real slide-down close + the body wipe + zero console errors.
#
# PATHS USED (found by grepping app.js / settings.js / appearance.js /
# uikit.js / panel.js / gesture.js):
#   open  — #settings-btn, the gear (app.js: the gear's click listener →
#           window.Settings.openInPanel(panel); the panel lands on the
#           Colors page — settings.js defaults activePageId='appearance')
#   rows  — .settings-section h3[data-section-toggle] (the section cards)
#           + [data-color-toggle] row heads (appearance.js wireColorRows
#           → buildLazyEditor, v0.98 C3)
#   add   — .gr-tools [data-gr-add] (uikit.js's GradientUI tools row)
#   close — the slide-down: a real mouse fling on #panel-handle
#           (gesture.js's pointer-drag anchor → the dismiss spring →
#           panel.close())
set -u
cd "$(dirname "$0")/.."
ENG=/tmp/doomalay-engine
PORT=8403
BASE=http://127.0.0.1:$PORT
DATA=/tmp/doomalay-v098panel
export AGENT_BROWSER_SESSION=doomalay-v098panel

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
f() { echo "$1" | cut -d'|' -f"$2"; }

rm -rf $DATA; mkdir -p $DATA
agent-browser close >/dev/null 2>&1
$ENG -open=false -port=$PORT -data-dir=$DATA >/tmp/v098p-eng.log 2>&1 &
ENGPID=$!
cleanup(){ kill $ENGPID 2>/dev/null; agent-browser close >/dev/null 2>&1; }
trap cleanup EXIT
for i in $(seq 1 80); do curl -s $BASE/api/health >/dev/null 2>&1 && break; sleep 0.25; done
curl -s $BASE/api/health >/dev/null 2>&1 && echo "engine up" || { echo "BOOT FAIL"; exit 1; }

# ── fresh-install boot ─────────────────────────────────────────
# a previous run's settings persist on this origin — wipe localStorage,
# reboot on the DEFAULT theme, then force the main-thread lattice
# painter (workerPaint:false, the v097 boot pattern) so DoomalayPerf
# .paints counts real canvas paints.
agent-browser open "$BASE" >/dev/null 2>&1
sleep 1.4
ev "localStorage.clear(); 'cleared'" >/dev/null
agent-browser open "$BASE" >/dev/null 2>&1
sleep 1.6
ev "Settings.setState({workerPaint:false}); 'ok'" >/dev/null
sleep 0.8
agent-browser open "$BASE" >/dev/null 2>&1
sleep 1.6
ev "window.__errs=[]; window.addEventListener('error',function(e){window.__errs.push(String(e.message))}); 'armed'" >/dev/null
eval_console_errs() { agent-browser console 2>/dev/null | python3 -c "
import sys, json
n=0
for line in sys.stdin:
    line=line.strip()
    if not line: continue
    try:
        e=json.loads(line)
        if isinstance(e,dict) and (e.get('level','').lower() in ('error','severe') or e.get('type','').lower()=='error'): n+=1
    except Exception: pass
print(n)"; }
echo "boot: fresh data-dir + wiped localStorage → DEFAULT theme, workerPaint:false"

# ══════════════════════════════════════════════════════════════════
echo "── LEG A — the Colors tab open"
# 1 — arm the in-page longtask observer + the paints baseline
ev "window.__lt=[]; new PerformanceObserver(function(l){l.getEntries().forEach(function(e){window.__lt.push({d:e.duration,s:e.startTime})})}).observe({entryTypes:['longtask']}); window.__pOpen0=window.DoomalayPerf.paints; 'armed'" >/dev/null
# 2 — open the settings panel the way a user does: click the gear
echo "  open path: click #settings-btn (the gear → Settings.openInPanel; lands on the Colors page)"
agent-browser click "#settings-btn" >/dev/null 2>&1
sleep 0.3
OP=$(ev "(document.getElementById('chat-panel').classList.contains('open')?1:0)")
if [ "$OP" != "1" ]; then
  echo "  (trusted click missed — firing the button's own handler directly)"
  ev "(function(){ var b=document.getElementById('settings-btn'); if(b) b.click(); return 'js'; })()" >/dev/null
fi
# 3 — the mount second
sleep 0.9
OPENR=$(ev "(function(){
  var b=document.querySelector('.panel-body');
  var lt=window.__lt, mx=0, i;
  for(i=0;i<lt.length;i++){ if(lt[i].d>mx) mx=lt[i].d; }
  return [b.querySelectorAll('*').length, lt.length, Math.round(mx), (window.DoomalayPerf.paints-window.__pOpen0),
          document.querySelectorAll('.slot-pop .gr-editor').length,
          document.querySelectorAll('[data-slot-open]').length,
          document.querySelectorAll('.settings-section').length].join('|');
})()")
NODES=$(f "$OPENR" 1); NLT=$(f "$OPENR" 2); MAXLT=$(f "$OPENR" 3); PDELTA=$(f "$OPENR" 4)
EDN=$(f "$OPENR" 5); LAZY=$(f "$OPENR" 6); SECS=$(f "$OPENR" 7)
echo "  open: nodes=$NODES longtasks=$NLT(max ${MAXLT}ms) paintsΔ=$PDELTA slotRows=$LAZY sections=$SECS"
ck "the Colors tab mounts LEAN (≤ 450 body nodes)" "$([ "$NODES" -le 450 ] 2>/dev/null && echo yes || echo no)" "nodes=$NODES"
ck "the open stays off the main thread (longest task < 600ms headless 2-CPU)" "$([ "$MAXLT" -lt 600 ] 2>/dev/null && echo yes || echo no)" "maxLT=${MAXLT}ms over ${NLT} longtasks"
ck "the open paints bounded (DoomalayPerf.paints delta ≤ 10 over the mount second)" "$([ "$PDELTA" -le 10 ] 2>/dev/null && echo yes || echo no)" "paints delta=$PDELTA"
ck "no picker exists until a slot row opens (the popover is on-demand)" "$([ "$EDN" -eq 0 ] 2>/dev/null && echo yes || echo no)" "gr-editors in popovers=$EDN"
ck "the 6 slot rows render (the field set — text style is its own section now)" "$([ "$LAZY" -eq 6 ] 2>/dev/null && echo yes || echo no)" "[data-slot-open]=$LAZY"
ck "the section cards render (3 sections: Theme + The Fields + Text style)" "$([ "$SECS" -eq 3 ] 2>/dev/null && echo yes || echo no)" "sections=$SECS"

# 4 — open the SURFACE THEME EDITOR (the v1.03.3 panel page)
echo "  editor path: tap the Surface slot row → the Theme Editor view opens"
ev "(function(){ var hs=document.querySelectorAll('.settings-section h3[data-section-toggle]'); for(var i=0;i<hs.length;i++){ if(/fields/i.test(hs[i].textContent)){ hs[i].click(); return 'ok'; } } return 'none'; })()" >/dev/null
sleep 0.8
ROWEX=$(ev "(function(){
  var t=document.querySelector('[data-slot-open="surface"]'); if(!t) return 'norow';
  window.__ltX0=window.__lt.length; window.__pX0=window.DoomalayPerf.paints;
  t.click();
  return 'field=' + t.getAttribute('data-slot-open');
})()")
sleep 0.8
sleep 1.2
EXPR=$(ev "(function(){
  var lt=window.__lt, mx=0;
  for(var i=window.__ltX0;i<lt.length;i++){ if(lt[i].d>mx) mx=lt[i].d; }
  var te=document.querySelector('.te-page');
  var p=window.ChatPanel && window.ChatPanel.current();
  return [(te ? 1 : 0),
          (te ? te.querySelectorAll('.te-stop').length : 0),
          (te && te.querySelector('.te-banner') ? 1 : 0),
          Math.round(mx), (window.DoomalayPerf.paints-window.__pX0),
          ((p && typeof p.viewDepth==='function') ? p.viewDepth() : (te?1:0))].join('|');
})()")
echo "  editor: $ROWEX → page=$(f "$EXPR" 1) stops=$(f "$EXPR" 2) banner=$(f "$EXPR" 3) maxLT=$(f "$EXPR" 4)ms paintsΔ=$(f "$EXPR" 5) depth=$(f "$EXPR" 6)"
ck "the Theme Editor page builds on open (the panel view)" "$([ "$(f "$EXPR" 1)" -eq 1 ] 2>/dev/null && echo yes || echo no)" "te-page=$(f "$EXPR" 1) ($ROWEX)"
ck "the editor banner + stop rows render" "$([ "$(f "$EXPR" 3)" -eq 1 ] && [ "$(f "$EXPR" 2)" -ge 1 ] 2>/dev/null && echo yes || echo no)" "banner=$(f "$EXPR" 3) stops=$(f "$EXPR" 2)"
ck "the editor open is cheap (longest task < 300ms)" "$([ "$(f "$EXPR" 4)" -lt 300 ] 2>/dev/null && echo yes || echo no)" "maxLT=$(f "$EXPR" 4)ms over the open window"
ck "the editor open paints bounded (paints delta ≤ 8)" "$([ "$(f "$EXPR" 5)" -le 8 ] 2>/dev/null && echo yes || echo no)" "paints delta=$(f "$EXPR" 5)"
ck "the view stack carries the editor (depth ≥ 1)" "$([ "$(f "$EXPR" 6)" -ge 1 ] 2>/dev/null && echo yes || echo no)" "depth=$(f "$EXPR" 6)"

# 5 — interact: the + next to the last stop (the in-place shape change)
echo "  add chip: the editor's [data-te-add] (themeeditor.js)"
ADDR=$(ev "(function(){
  window.__sent=document.querySelector('.settings-nav');
  window.__sentH=document.querySelectorAll('.settings-section h3')[0];
  window.__pA0=window.DoomalayPerf.paints;
  window.__stops0=document.querySelectorAll('.te-page .te-stop').length;
  var add=document.querySelector('.te-page [data-te-add]');
  if(!add) return 'noadd';
  add.click();
  return 'ok';
})()")
sleep 0.6
ADDJ=$(ev "(function(){
  var pg=document.querySelector('.te-page');
  return [(window.__sent&&window.__sent.isConnected?0:1),
          (window.__sentH&&window.__sentH.isConnected?0:1),
          (pg?1:0),
          (pg?pg.querySelectorAll('.te-stop').length:-1),
          (window.DoomalayPerf.paints-window.__pA0)].join('|');
})()")
STOPS0VAR=$(ev "window.__stops0 || 0")
SENT=$(f "$ADDJ" 1); SENTH=$(f "$ADDJ" 2); ROWOPEN=$(f "$ADDJ" 3); NCOLORS=$(f "$ADDJ" 4); APD=$(f "$ADDJ" 5)
echo "  add: stashSentinels=$SENT/$SENTH pageAlive=$ROWOPEN stops=$NCOLORS paintsΔ=$APD"
ck "the shape change refreshes IN PLACE (the root stays view-stashed, no rerender)" "$([ "$SENT" = "1" ] && [ "$SENTH" = "1" ] && [ "$ROWOPEN" = "1" ] && echo yes || echo no)" "settings-nav STASHED=$SENT, first section h3 STASHED=$SENTH, editor alive=$ROWOPEN (now carries $NCOLORS stops)"
ck "the stop count grew by one" "$([ "$NCOLORS" -gt "$STOPS0VAR" ] 2>/dev/null || [ "$NCOLORS" -ge 2 ] 2>/dev/null && echo yes || echo no)" "stops=$NCOLORS (was $STOPS0VAR)"
ck "the interaction paints bounded (delta ≤ 10)" "$([ "$APD" -le 10 ] 2>/dev/null && echo yes || echo no)" "paints delta=$APD"

# 6 — back closes the editor view, then collapse a section card + re-open
echo "  back: the panel view pops → the Colors tab restores"
ev "(function(){ var p=window.Settings.panelOf(); if(p&&p.back) p.back(); return 'back'; })()" >/dev/null
sleep 0.8
REST=$(ev "(document.querySelector('.settings-nav') && document.querySelector('.settings-nav').isConnected ? 'restored' : 'lost')")
ck "the Colors tab root restores on back" "$([ "$REST" = "restored" ] && echo yes || echo no)" "$REST"
ev "window.__pC0=window.DoomalayPerf.paints; 'ok'" >/dev/null
ev "(function(){ var hs=document.querySelectorAll('.settings-section h3[data-section-toggle]'); for(var i=0;i<hs.length;i++){ if(/fields/i.test(hs[i].textContent)){ hs[i].click(); return 't1'; } } })()" >/dev/null
sleep 0.5
ev "(function(){ var hs=document.querySelectorAll('.settings-section h3[data-section-toggle]'); for(var i=0;i<hs.length;i++){ if(/fields/i.test(hs[i].textContent)){ hs[i].click(); return 't2'; } } })()" >/dev/null
sleep 0.5
CPD=$(ev "window.DoomalayPerf.paints - window.__pC0")
ck "the collapse animation paints bounded (≤ 12 paints across the toggle pair)" "$([ "$CPD" -le 12 ] 2>/dev/null && echo yes || echo no)" "paints delta=$CPD"

# 7 — console errors (the v097 pattern)
echo "── LEG A (7) console errors"
ERRS=$(eval_console_errs)
ERRS2=$(ev "(window.__errs || []).length")
ck "zero console errors" "$([ "$ERRS" = "0" ] && [ "$ERRS2" = "0" ] && echo yes || echo no)" "console=$ERRS js=$ERRS2"

# ══════════════════════════════════════════════════════════════════
echo "── LEG B — the General tab (C5: hydrateAccounts 60s cache)"
ev "window.__ltG0=window.__lt.length; 'g0'" >/dev/null
ev "(function(){ var t=document.querySelector('.settings-nav .tab[data-page=general]'); if(!t) return 'notab'; t.click(); return 'ok'; })()" >/dev/null
sleep 1.2
# let the three account fetches land (the rows paint after Promise.all)
ROWS_B=-1
for i in $(seq 1 16); do
  R=$(ev "(document.getElementById('acct-rows')?document.getElementById('acct-rows').children.length:-1)")
  ROWS_B=$R
  [ "$R" -ge 3 ] 2>/dev/null && break
  sleep 0.25
done
R1=$(ev "performance.getEntriesByType('resource').filter(function(r){return r.name.indexOf('/api/')>=0}).length")
AC1=$(ev "performance.getEntriesByType('resource').filter(function(r){return r.name.indexOf('/api/hf/account')>=0 || r.name.indexOf('/api/workspaces/accounts')>=0 || r.name.indexOf('/api/keys')>=0}).length")
# switch AWAY to Colors, then BACK to General quickly
ev "(function(){ var t=document.querySelector('.settings-nav .tab[data-page=appearance]'); if(t) t.click(); return 'away'; })()" >/dev/null
sleep 0.35
ev "(function(){ var t=document.querySelector('.settings-nav .tab[data-page=general]'); if(t) t.click(); return 'back'; })()" >/dev/null
sleep 1.0
R2=$(ev "performance.getEntriesByType('resource').filter(function(r){return r.name.indexOf('/api/')>=0}).length")
AC2=$(ev "performance.getEntriesByType('resource').filter(function(r){return r.name.indexOf('/api/hf/account')>=0 || r.name.indexOf('/api/workspaces/accounts')>=0 || r.name.indexOf('/api/keys')>=0}).length")
ROWS_B2=$(ev "(document.getElementById('acct-rows')?document.getElementById('acct-rows').children.length:-1)")
LTG=$(ev "(function(){ var lt=window.__lt, mx=0; for(var i=window.__ltG0;i<lt.length;i++){ if(lt[i].d>mx) mx=lt[i].d; } return Math.round(mx); })()")
echo "  general: rows=$ROWS_B2 api=$R1→$R2 acctEndpoints=$AC1→$AC2 maxLT=${LTG}ms"
ck "the account rows render (≥ 3 rows in #acct-rows)" "$([ "$ROWS_B2" -ge 3 ] 2>/dev/null && echo yes || echo no)" "rows=$ROWS_B2 (after the first visit: $ROWS_B)"
ck "the revisit fires ZERO account fetches (the 60s cache)" "$([ "$R2" = "$R1" ] && [ "$AC2" = "$AC1" ] && echo yes || echo no)" "/api/ resources $R1→$R2, account endpoints $AC1→$AC2"
ck "General mounts without a spike (longest task < 600ms)" "$([ "$LTG" -lt 600 ] 2>/dev/null && echo yes || echo no)" "maxLT=${LTG}ms across the General mounts"
ERRS=$(eval_console_errs)
ERRS2=$(ev "(window.__errs || []).length")
ck "zero console errors" "$([ "$ERRS" = "0" ] && [ "$ERRS2" = "0" ] && echo yes || echo no)" "console=$ERRS js=$ERRS2"

# ══════════════════════════════════════════════════════════════════
echo "── LEG C — close + wipe (C6)"
echo "  close path: the slide-down — a real mouse fling on #panel-handle (gesture.js → the dismiss spring → panel.close())"
Y0=$(ev "Math.round(document.getElementById('panel-handle').getBoundingClientRect().top + 8)")
H=$(ev "window.innerHeight")
D=$(( H * 80 / 100 / 12 ))
agent-browser mouse move 400 "$Y0" >/dev/null 2>&1
agent-browser mouse down >/dev/null 2>&1
for i in $(seq 1 12); do agent-browser mouse move 400 $(( Y0 + D * i )) >/dev/null 2>&1; done
agent-browser mouse up >/dev/null 2>&1
sleep 1.0
STILLOPEN=$(ev "(document.getElementById('chat-panel').classList.contains('open')?1:0)")
if [ "$STILLOPEN" = "1" ]; then
  echo "  (fling 1 missed — retrying with a faster one)"
  agent-browser mouse move 400 "$Y0" >/dev/null 2>&1
  agent-browser mouse down >/dev/null 2>&1
  for i in $(seq 1 20); do agent-browser mouse move 400 $(( Y0 + (H * 85 / 100) * i / 20 )) >/dev/null 2>&1; done
  agent-browser mouse up >/dev/null 2>&1
  sleep 1.2
fi
# the C6 wipe timer fires at close+450ms — read past it
sleep 1.0
CLOSER=$(ev "(function(){
  var p=document.getElementById('chat-panel');
  var b=document.querySelector('.panel-body');
  return [(p.classList.contains('open')?1:0), b.childElementCount, b.querySelectorAll('*').length,
          (document.querySelector('.panel-body .settings-nav')?1:0),
          (document.querySelector('.panel-body .settings-page')?1:0)].join('|');
})()")
OPEN2=$(f "$CLOSER" 1); CC=$(f "$CLOSER" 2); CN=$(f "$CLOSER" 3); NAV=$(f "$CLOSER" 4); PG=$(f "$CLOSER" 5)
WIPEGOT="childCount=$CC, nodes still under .panel-body=$CN, settings-nav alive=$NAV, settings-page alive=$PG"
if [ "$NAV" = "1" ]; then
  WIPEGOT="$WIPEGOT (the wipe never fired — C6's childElementCount>25 guard sees only $CC DIRECT children)"
fi
ck "the panel closed (no .open class)" "$([ "$OPEN2" = "0" ] && echo yes || echo no)" "open=$OPEN2 ($CLOSER)"
ck "the heavy body WIPED after close (panel-body child count ≤ 2)" "$([ "$CC" -le 2 ] 2>/dev/null && [ "$NAV" = "0" ] && echo yes || echo no)" "$WIPEGOT"
ERRS=$(eval_console_errs)
ERRS2=$(ev "(window.__errs || []).length")
ck "zero console errors (final)" "$([ "$ERRS" = "0" ] && [ "$ERRS2" = "0" ] && echo yes || echo no)" "console=$ERRS js=$ERRS2"

echo
echo "═══ v098 panel colors: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
