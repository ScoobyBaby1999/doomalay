#!/usr/bin/env python3
# v1.55.2 THE ROW OF PILLS — source pins (the user's device-report law):
#   1. THE ORDER LAW: opencode sits BELOW privatemodeai + nvidia (FREE_ORDER
#      + smartConnect PRIORITY aligned).
#   2. THE SAME-ROW LAW: the opencode bridge STATE BOX is GONE — the row
#      renders like every other provider (Get API key + pills only).
#   3. THE PILL SYSTEM: generic pills spawn LEFT→RIGHT next to Get API key
#      (providerPills — attachable to ANY provider); the state ladder:
#      ready → "+ install opencode" (action) · installing → live pinging
#      pill (tone + pulse + real percent) · install_failed → "failed,
#      retry" · up/desktop → dim "✓ opencode setup" · gates → "+ setup
#      termux" (TermuxSetup hand-off) · installed termux → dim "✓ termux
#      setup".
#   4. THE THEME LAW: every pill byte rides the theme tokens (zero
#      hardcoded colors; prefers-reduced-motion freezes the pulse).
#   5. THE SERVICE-ACCOUNTS LAW: opencode's Get API key lands on the
#      org-less console deep link (opencode resolves the user's own
#      workspace after login — "the org_xyz replaced by the users own
#      workspace or whatever it is opencode does").
#   6. THE HONEST POLL: AbortController + single-flight (the pool law).
import re
import sys
import json

WEB = "engine/internal/server/web/providers.js"
CAT = "engine/internal/llm/catalog/providers.json"

fails = []


def check(name, ok, detail=""):
    print(("  PASS " if ok else "  FAIL ") + name + ((" :: " + detail) if detail and not ok else ""))
    if not ok:
        fails.append(name)


js = open(WEB, encoding="utf-8").read()
cat = json.load(open(CAT, encoding="utf-8"))

print("v1.55.2 THE ROW OF PILLS pins")

# 1. THE ORDER LAW
m = re.search(r"var FREE_ORDER = \[(.*?)\];", js)
order = [s.strip().strip("'\"") for s in m.group(1).split(",")] if m else []
check("opencode sits below privatemodeai + nvidia (row order)",
      order[:3] == ["privatemodeai", "nvidia", "opencode"], str(order[:4]))
m2 = re.search(r"var PRIORITY = \[(.*?)\];", js)
prio = [s.strip().strip("'\"") for s in m2.group(1).split(",")] if m2 else []
check("smartConnect PRIORITY aligned", prio[:3] == ["privatemodeai", "nvidia", "opencode"], str(prio[:3]))

# 2. THE SAME-ROW LAW
check("the bridge state box is GONE (no bridgeHTML)", "bridgeHTML" not in js)
check("no data-oc-install box buttons left (pills own the actions)",
      "data-oc-install=" not in js)
check("the getkey hint stays (same as other rows)", "getkey-hint-" in js)

# 3. THE PILL SYSTEM
check("the generic providerPills table exists", "function providerPills(name)" in js)
check("pills spawn left→right next to Get API key (the flex row wraps the link + pills)",
      re.search(r"thisRowPills\s*\?[^?]*display:flex;align-items:center;gap:6px;flex-wrap:wrap", js) is not None)
check("no pills → the row is byte-identical to every other provider",
      js.count(">Get API key") == 2, "both branches render the identical link")  # the pill branch + the plain branch
for state, needle in [
    ("ready → + install opencode", "'+ install opencode'"),
    ("installing → the live pinging pill (percent rides the poll)", "installing opencode"),
    ("install_failed → failed, retry", "'failed, retry'"),
    ("up/desktop → dim ✓ opencode setup", "'\\u2713 opencode setup'" if "'✓ opencode setup'" not in js else "'✓ opencode setup'"),
    ("gates → + setup termux (TermuxSetup hand-off)", "'+ setup termux'"),
    ("installed termux → dim ✓ termux setup", "'✓ termux setup'" if "'✓ termux setup'" in js else "'\\u2713 termux setup'"),
]:
    check("pill ladder: " + state, needle in js)
check("the installing pill arms the live poll", "ocBridgeStartPoll()" in js)
check("pill buttons ride the pill attributes (install + termux)",
      'data-oc-pill="oc-install"' in js and 'data-oc-pill="oc-termux"' in js)
check("the install POST answers gate closures on the toast (honest gates)",
      re.search(r"d\.ok === false && d\.detail && window\.toast", js) is not None)

# 4. THE THEME LAW (the pill constants ride tokens; zero hex in them)
mp = re.search(r"var PILL_BASE = (.*?);\n", js)
pillblock = js[js.index("var PILL_BASE"):js.index("(function injectPillStyles")]
hexes = re.findall(r"#[0-9a-fA-F]{3,8}\b", pillblock)
check("the pill style block has ZERO hardcoded colors (theme tokens only)", not hexes, str(hexes[:4]))
check("the pulse keyframe rides --accent-2-rgb", "rgba(var(--accent-2-rgb)" in js)
check("prefers-reduced-motion freezes the pulse", "prefers-reduced-motion" in js)
check("the live tone is a DIFFERENT theme color (--accent-2, not the action accent)",
      "PILL_LIVE = PILL_BASE + ';color:var(--accent-2)" in js)
check("the err tone rides --err-rgb", "rgba(var(--err-rgb)" in js)
check("the dim tone rides --text-3/--surface-2", "PILL_DIM = PILL_BASE + ';color:var(--text-3);background:var(--surface-2)" in js)

# 5. THE SERVICE-ACCOUNTS LAW
check("opencode Get API key → the org-less console service-accounts deep link",
      cat["opencode"]["signup_url"] == "https://opencode.ai/console/settings/service-accounts",
      cat["opencode"]["signup_url"])
check("the deep link is org-LESS (opencode resolves the user's own workspace)",
      "org_" not in cat["opencode"]["signup_url"])

# 6. THE HONEST POLL (v1.55.1's PWA half, re-pinned)
check("the poll aborts (AbortController)", "new AbortController()" in js)
check("the poll is single-flight (never stacks)", "ocPollInFlight" in js)

print()
if fails:
    print("v1552 pill pins: " + str(len(fails)) + " FAIL")
    sys.exit(1)
print("v1552 pill pins: PASS")
