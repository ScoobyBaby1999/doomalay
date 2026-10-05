#!/bin/bash
# v1040-discipline-audit.sh — THE PERMANENT DISCIPLINE AUDIT (v1.04.5).
#
# The enforcement rig for the two standing rules (docs/DISCIPLINE.md):
#   A. THEME DISCIPLINE — no hardcoded colors outside the canonical zones.
#   B. SURFACE DISCIPLINE — front-facing screens ride the Panel or the
#      Overlay Screen (chrome ladder documented).
#   C. CANON-TWIN CHECK — the load-order twins equal theme.js's canon.
# Wire into any battery: exits non-zero on a NEW violation.
set -u
cd "$(dirname "$0")/.."
WEB=engine/internal/server/web
PASS=0; FAIL=0
ok(){ if [ "$2" = "1" ]; then echo "PASS $1"; PASS=$((PASS+1)); else echo "FAIL $1 :: $3"; FAIL=$((FAIL+1)); fi; }

echo "═══ A. THEME DISCIPLINE ═══"

# A1: shadow/tint literals in the swept JS+HTML — only the canonical
# survivors are allowed. Filters:
#   · comment lines (// …) and the doc spelling rgba(0,0,0,α) (greek α)
#   · CANON: marked lines (in-code markers for functional colors)
#   · the fully-transparent gradient ends (rgba(…,0) = transparency)
#   · the art-ink constant pair (hub.js — ink on USER art, functional)
A1=$(grep -n "rgba(0,0,0\|rgba(0, 0, 0\|rgba(255,255,255\|rgba(255, 255, 255\|rgba(10,10,14" \
  $WEB/index.html $WEB/*.js 2>/dev/null \
  | grep -v "vendor/" \
  | grep -v "FALLBACKS\|CANON-TWIN\|CANON:" \
  | grep -v "//" \
  | grep -v "rgba(0,0,0,α)" \
  | grep -v "rgba(0,0,0,0)\|rgba(255,255,255,0)\|rgba(0, 0, 0, 0)" \
  | grep -v "radial-gradient(circle at center, #ffffff" \
  | grep -v "rgba(255,0,0,0.85)" \
  | grep -v "rgba(6,6,10,0.78)" \
  | grep -v "rgba(255,255,255,0.85)" \
  | grep -v "rgba(120,130,140" \
  | grep -v "rgba(10,10,14,0.92)" \
  | wc -l | tr -d ' ')
ok "A1-shadow-tint-literals-canonical-only" "$(python3 -c "print(1 if $A1 == 0 else 0)")" "count=$A1 (see below)"
[ "$A1" != "0" ] && grep -n "rgba(0,0,0\|rgba(255,255,255" $WEB/index.html $WEB/*.js 2>/dev/null | grep -v "vendor/\|FALLBACKS\|CANON-TWIN\|CANON:\|//\|radial-gradient\|rgba(255,0,0\|rgba(6,6,10\|rgba(255,255,255,0.85)\|rgba(120,130,140" | head -10

# A2: scattered hex fallbacks in the consumer modules — allowed ONLY as
# the node-harness catch twin (uikit) or with a CANON-TWIN comment.
A2=$(grep -n "'#4a4a5e'\|'#0a0a0b'\|'#22d3ee'\|'#14141a'\|'#2e2e3a'\|'#131318'" \
  $WEB/lattice.js $WEB/atoms.js $WEB/pixiworld.js $WEB/doomprojection.js \
  $WEB/webtweaks.js $WEB/appearance.js $WEB/tweaks.js $WEB/app.js \
  $WEB/persona.js $WEB/doomprojection.js 2>/dev/null | wc -l | tr -d ' ')
ok "A2-fallback-literals-canon-owned" "$(python3 -c "print(1 if $A2 == 0 else 0)")" "count=$A2"

# A3: the canon exists and carries the pinned values
A3=$(grep -c "canvas: '#101016'" $WEB/theme.js)
ok "A3-canon-exists" "$(python3 -c "print(1 if $A3 >= 1 else 0)")" "theme.js FALLBACKS.canvas missing"

echo "═══ B. SURFACE DISCIPLINE ═══"

# B1: body-appended full-screen surfaces — the sanctioned set is:
#   connectoverlay.js (THE Overlay Screen), artifacts.js (the sheet
#   variant), recovery.js (crash-only, z-max), uikit.js (chrome: crop,
#   toasts), msgactions.js (action sheet), perfhud.js (diagnostics),
#   formatter.js (hidden copy nodes), lookio/persona/providers (hidden
#   download anchors), webpanel.js (hidden iframe park), app.js (none),
#   doomprojection.js (the canvas itself).
B1=$(grep -ln "body.appendChild\|body.append(" $WEB/*.js 2>/dev/null | grep -v "vendor/" | grep -vc "connectoverlay.js\|artifacts.js\|recovery.js\|uikit.js\|msgactions.js\|perfhud.js\|formatter.js\|lookio.js\|persona.js\|providers.js\|webpanel.js\|doomprojection.js\|appearance.js\|keys.js")
ok "B1-body-appenders-sanctioned" "$(python3 -c "print(1 if $B1 == 0 else 0)")" "new appender count=$B1"
[ "$B1" != "0" ] && grep -ln "body.appendChild" $WEB/*.js | grep -v "vendor/\|connectoverlay.js\|artifacts.js\|recovery.js\|uikit.js\|msgactions.js\|perfhud.js\|formatter.js\|lookio.js\|persona.js\|providers.js\|webpanel.js\|doomprojection.js\|appearance.js\|keys.js"

echo "═══ C. CANON-TWIN CHECK ═══"

# A4 (theme, sentinel guard): the reset paths write the SENTINELS — a
# reset that wrote a paint hex would PIN the grid instead of returning
# it to theme-following (DoomTheme.LEGACY_GRID is the single owner).
A4=$(grep -c "DoomTheme.FALLBACKS.canvas" $WEB/appearance.js)
ok "A4-resets-write-sentinels-not-canvas" "$(python3 -c "print(1 if $A4 == 1 else 0)")" "FALLBACKS.canvas in appearance.js=$A4 (want 1: the cbRaw paint fallback only)"

# C1: settings.js's parse-time seeds equal the LEGACY_GRID sentinels
# (the "never customized" contract — the load-order twins)
C1=$(python3 - <<'EOF'
import re
theme = open('engine/internal/server/web/theme.js').read()
settings = open('engine/internal/server/web/settings.js').read()
m = re.search(r"LEGACY_GRID = \{[^}]*\}", theme)
lg = m.group(0) if m else ''
pairs = [('bg', 'bg'), ('line', 'lineColor'), ('dot', 'dotColor'), ('origin', 'originColor')]
bad = []
for lname, sname in pairs:
    mm = re.search(lname + r": '(#[0-9a-fA-F]{6})'", lg)
    cv = mm.group(1).lower() if mm else None
    m2 = re.search(r"^\s*" + sname + r": '(#[0-9a-fA-F]{6})'", settings, re.M)
    sv = m2.group(1).lower() if m2 else None
    if cv != sv or cv is None:
        bad.append((lname, cv, sname, sv))
if bad: print('BAD:', bad)
print(0 if bad else 1)
EOF
)
ok "C1-canon-twins-equal" "$C1" "settings.js seed drifted from theme.js LEGACY_GRID"

# C2: the uikit node-harness twin equals the canon pair
C2=$(python3 - <<'EOF'
import re
theme = open('engine/internal/server/web/theme.js').read()
uikit = open('engine/internal/server/web/uikit.js').read()
m = re.search(r"FALLBACKS: \{[^}]*?accent2: '(#[0-9a-fA-F]{6})'", theme, re.S)
a2 = m.group(1).lower() if m else None
m = re.search(r"FALLBACKS: \{[^}]*?accent: '(#[0-9a-fA-F]{6})'", theme, re.S)
a1 = m.group(1).lower() if m else None
m = re.search(r"catch \(e\) \{ return \['(#[0-9a-fA-F]{6})', '(#[0-9a-fA-F]{6})'\]; \}", uikit)
okv = m and m.group(1).lower() == a2 and m.group(2).lower() == a1
print(1 if okv else 0)
EOF
)
ok "C2-uikit-harness-twin-equals-canon" "$C2" "uikit catch twin drifted"

echo "═══ THE LADDER (documented, not asserted) ═══"
echo "  2147483647 recovery (crash-only) · 3500 action sheet · 3400 chrome"
echo "  (toasts, crop, keys sheet) · 3000 the two overlay surfaces · 2600 send-menu"

echo "════════════════════════════"
echo "v1040 discipline audit: $PASS passed, $FAIL failed"
[ $FAIL -eq 0 ]
