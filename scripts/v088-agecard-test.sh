#!/bin/bash
# v088-agecard-test.sh — THE AGE-CARD REWORK PROOF (user spec: the
# community-space redirect warning gets a warning icon + accent-3, the
# BYOK paste affordance goes away, the "your keys stay yours" section
# states the Connect Cloud Providers truth).
#
# THE CONTRACT (a stubbed 403 account_age on the space-create flow):
#  (1) the age card renders: the .hf-age-warn block carries the REAL
#      triangle-alert glyph (IconLib svg, currentColor) and the whole
#      block rides ACCENT-3 (computed background rgba(accent-3-rgb,.1) +
#      border .45 — the warning tone, not the old accent-2);
#  (2) the icon's computed color IS var(--accent-3);
#  (3) the BYOK affordance is GONE (no ghost button, no "bring your own
#      key" section) and the actions hold exactly ONE button;
#  (4) the "your keys stay yours" section exists with the honest
#      encryption wording (AES-256 on device / TLS in flight / read only
#      for the turn / never stored) + the Connect Cloud Providers truth;
#  (5) the copy + go affordances still work (copy node present);
#  (6) zero console errors.
set -u
cd "$(dirname "$0")/.."
ENG=/tmp/doomalay-engine
PORT=8389
BASE=http://127.0.0.1:$PORT
DATA=/tmp/doomalay-v088a
export AGENT_BROWSER_SESSION=doomalay-v088a

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
agent-browser close >/dev/null 2>&1
$ENG -open=false -port=$PORT -data-dir=$DATA >/tmp/v088a-eng.log 2>&1 &
ENGPID=$!
cleanup(){ kill $ENGPID 2>/dev/null; agent-browser close >/dev/null 2>&1; }
trap cleanup EXIT
for i in $(seq 1 80); do curl -s $BASE/api/health >/dev/null 2>&1 && break; sleep 0.25; done
curl -s $BASE/api/health >/dev/null 2>&1 && echo "engine up" || { echo "BOOT FAIL"; exit 1; }

agent-browser open "$BASE" >/dev/null 2>&1; sleep 2.0
ev "localStorage.clear(); 'ok'" >/dev/null
agent-browser reload >/dev/null 2>&1; sleep 2.0

# stub the HF flow: account=connected + space-create=403 account_age.
# (the stub text rides a FILE — long multi-line strings passed through
# bash variables + the CLI arg can get mangled; the file is byte-exact)
cat > /tmp/v088-stub.js <<'STUBEOF'
(function(){
  var orig = window.fetch;
  window.__origFetch = orig;
  window.fetch = function (url, opts) {
    var u = String(url);
    if (u.indexOf('/api/hf/account') !== -1) {
      return Promise.resolve(new Response(JSON.stringify({connected:true, user:'rigtester'}), {status:200, headers:{'Content-Type':'application/json'}}));
    }
    if (u.indexOf('/api/hf/space/create') !== -1) {
      return Promise.resolve(new Response(JSON.stringify({error:'Hugging Face needs your account to be 30+ days old to create a Space', code:'account_age'}), {status:403, headers:{'Content-Type':'application/json'}}));
    }
    return orig.apply(this, arguments);
  };
  return 'stubbed';
})()
STUBEOF
ev "$(cat /tmp/v088-stub.js)" >/dev/null

# open the sandbox picker → the HF card → the spaces view → create → the age card
PICK=$(ev "window.SandboxPicker.open(function(){}); 'picker'")
sleep 0.9
# click the Hugging Face option card (data-sandbox="hf" — the 2nd option)
HFCLICK=$(ev "(function(){ var card = document.querySelector('[data-sandbox=hf]'); if (card) { card.click(); return 'clicked'; } var cards = document.querySelectorAll('[data-sandbox]'); for (var i = 0; i < cards.length; i++) { if (String(cards[i].textContent || '').indexOf('Hugging Face') !== -1) { cards[i].click(); return 'clicked'; } } return 'nocard:' + cards.length + ':stub=' + (typeof window.__origFetch); })()")
ck "the HF option card opens the spaces view" "$([ "$HFCLICK" = "clicked" ] && echo yes || echo no)" "$HFCLICK"
sleep 1.0
# the create pill expands the inline form → Create → stubbed 403 → the age card
CR=$(ev "(function(){
  var pill = document.getElementById('hf-create-pill');
  if (!pill) return 'nopill';
  pill.click();
  return 'pill';
})()")
ck "the create pill expands the form" "$([ "$CR" = "pill" ] && echo yes || echo no)" "$CR"
sleep 0.6
GO=$(ev "(function(){
  var btn = document.getElementById('hf-new-go');
  if (!btn) return 'nobtn';
  btn.click();
  return 'go';
})()")
ck "the Create button fires the (stubbed) build" "$([ "$GO" = "go" ] && echo yes || echo no)" "$GO"
sleep 1.2

echo "── (1)+(2) the warning block: glyph + accent-3"
A3=$(ev "(function(){
  var warn = document.querySelector('.hf-age-warn');
  if (!warn) return 'nowarn';
  var ic = warn.querySelector('.hf-age-warn-ic');
  var svg = ic ? ic.querySelector('svg.icl-triangle-alert') : null;
  var cs = warn ? getComputedStyle(warn) : null;
  var icCs = ic ? getComputedStyle(ic) : null;
  return JSON.stringify({
    warn: !!warn,
    hasIcon: !!svg,
    bg: cs ? cs.backgroundColor : '',
    bd: cs ? cs.borderTopColor : '',
    icColor: icCs ? icCs.color : ''
  });
})()")
ck "the age card renders with the REAL triangle-alert glyph" \
   "$(python3 -c "
import json
try:
    d=json.loads('''$A3''')
    print('yes' if d.get('warn') and d.get('hasIcon') else 'no')
except Exception: print('no')")" "$A3"
ck "the warning block rides ACCENT-3 (bg .1 + border .45 alphas)" \
   "$(python3 -c "
import json
try:
    d=json.loads('''$A3''')
    bg=str(d.get('bg','')); bd=str(d.get('bd',''))
    ok = '0.1' in bg and ('0.45' in bd or '0.4' in bd)
    # the SAME rgb triple must drive both (accent-3's)
    import re
    m1=re.findall(r'[\d]+', bg); m2=re.findall(r'[\d]+', bd)
    same = m1[:3] == m2[:3] and len(m1) >= 3
    print('yes' if ok and same else 'no')
except Exception: print('no')")" "$A3"
ck "the icon's computed color IS var(--accent-3)" \
   "$(python3 -c "
import json, re
try:
    d=json.loads('''$A3''')
    ic=str(d.get('icColor',''))
    bg=str(d.get('bg',''))
    m1=re.findall(r'[0-9]+', bg); m2=re.findall(r'[0-9]+', ic)
    print('yes' if m1[:3]==m2[:3] and len(m2)>=3 else 'no')
except Exception: print('no')")" "$A3"

echo "── (3)+(4) BYOK gone + the keys-stay-yours truth"
BODY=$(ev "(function(){
  var card = document.querySelector('.hf-age-card');
  if (!card) return 'nocard';
  var txt = String(card.textContent || '');
  return JSON.stringify({
    ghost: !!document.getElementById('hf-age-key'),
    byok: txt.indexOf('bring your own key') !== -1,
    keys: txt.indexOf('your keys stay yours') !== -1,
    providers: txt.indexOf('Connect Cloud Providers') !== -1,
    aes: txt.indexOf('AES-256') !== -1,
    tls: txt.indexOf('TLS in flight') !== -1,
    turn: txt.indexOf('readable only for the turn') !== -1,
    stored: txt.indexOf('never stored') !== -1,
    buttons: card.querySelectorAll('button').length
  });
})()")
ck "the BYOK affordance is GONE (no ghost button, no section)" \
   "$(python3 -c "
import json
try:
    d=json.loads('''$BODY''')
    print('yes' if not d.get('ghost') and not d.get('byok') else 'no')
except Exception: print('no')")" "$BODY"
ck "exactly ONE action button (the community go)" \
   "$(python3 -c "
import json
try:
    d=json.loads('''$BODY''')
    print('yes' if d.get('buttons') == 1 else 'no')
except Exception: print('no')")" "$BODY"
ck "the keys section states the provider-screen truth + the encryption chain" \
   "$(python3 -c "
import json
try:
    d=json.loads('''$BODY''')
    ok = d.get('keys') and d.get('providers') and d.get('aes') and d.get('tls') and d.get('turn') and d.get('stored')
    print('yes' if ok else 'no')
except Exception: print('no')")" "$BODY"
ck "the copy + go affordances still live (the community fallback intact)" \
   "$(python3 -c "
import json
try:
    d=json.loads('''$BODY''')
    print('yes' if d.get('buttons') == 1 else 'no')
except Exception: print('no')")" "$BODY"
COPY=$(ev "!!document.getElementById('hf-age-copy')")
ck "the tap-to-copy URL row exists" "$(python3 -c "print('yes' if '''$COPY'''.lower() == 'true' else 'no')")" "$COPY"

echo "── (5) console errors"
ERRS=$(agent-browser console 2>/dev/null | python3 -c "
import sys, json
n=0
for line in sys.stdin:
    line=line.strip()
    if not line: continue
    try:
        e=json.loads(line)
        if isinstance(e,dict) and e.get('level','').lower() in ('error','severe'): n+=1
        elif isinstance(e,dict) and e.get('type','').lower()=='error': n+=1
    except Exception: pass
print(n)")
ck "zero console errors" "$([ "$ERRS" = "0" ] && echo yes || echo no)" "$ERRS"

echo ""
echo "════ v088 AGE-CARD REWORK: $PASS passed, $FAIL failed"
[ "$FAIL" = "0" ] || exit 1
