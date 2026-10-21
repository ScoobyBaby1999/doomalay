#!/usr/bin/env python3
# v1.55.4 THE LIVE EFFORT — the zero-static source pins: the per-model
# static surfaces are DEAD from the engine's serving path (the user's law:
# "no static lists, not even fallback"). Every pin greps the REAL tree.
import re
import sys

fails = []


def check(name, ok, detail=""):
    print(("  PASS " if ok else "  FAIL ") + name + ((" :: " + detail) if detail and not ok else ""))
    if not ok:
        fails.append(name)


def grep_go(pattern):
    """Grep the engine's NON-TEST Go sources for a pattern."""
    hits = []
    import os
    import glob
    for path in glob.glob("engine/internal/**/*.go", recursive=True):
        if path.endswith("_test.go") or "/hfzero/brain/" in path:
            continue
        try:
            src = open(path, encoding="utf-8").read()
        except Exception:
            continue
        if re.search(pattern, src):
            hits.append(path)
    return hits


print("v1.55.4 THE LIVE EFFORT — zero-static pins")

# 1. the free-model literals are dead (all three copies)
check("no big-pickle literal in the serving path",
      not grep_go(r'"big-pickle"'),
      str(grep_go(r'"big-pickle"')[:3]))
check("no -free suffix heuristic for free detection",
      not grep_go(r'HasSuffix\([^)]*"-free"\)'),
      str(grep_go(r'HasSuffix\([^)]*"-free"\)')[:3]))
check("no paidExceptions table",
      not grep_go(r'paidExceptions'))

# 2. the curated effort + reasoning surfaces are dead
check("no pmFamilyEffort (the PM docs table)",
      not grep_go(r'pmFamilyEffort'))
check("no providerDefaultLevels/Effort (the blankets)",
      not grep_go(r'providerDefaultLevels|providerDefaultEffort'))
check("no resolveReasoningEntry (the curated reasoning catalog)",
      not grep_go(r'resolveReasoningEntry'))
check("no reasoningCatalog embed/machinery",
      not grep_go(r'reasoningCatalogJSON|loadReasoningCatalog'))

# 3. the files are gone from the tree
import os
check("catalog/reasoning_catalog.json is GONE",
      not os.path.exists("engine/internal/llm/catalog/reasoning_catalog.json"))
check("catalog/modelsdev_snapshot.json.gz is GONE",
      not os.path.exists("engine/internal/llm/catalog/modelsdev_snapshot.json.gz"))
check("scripts/modelsdev_snapshot.py is GONE",
      not os.path.exists("scripts/modelsdev_snapshot.py"))

# 4. the probe pins are dead
import json
cat = json.load(open("engine/internal/llm/catalog/providers.json"))
check("no probe_model pin in ANY provider", all("probe_model" not in c for c in cat.values()))
# the pin walks CODE LINES (a law comment may name the dead thing; a live
# field access or json tag may not)
def grep_probe_field():
    import re as _re
    hits = []
    for path in __import__('glob').glob("engine/internal/**/*.go", recursive=True):
        if path.endswith("_test.go") or "/hfzero/brain/" in path:
            continue
        for i, line in enumerate(open(path, encoding="utf-8").read().splitlines(), 1):
            code = line.split("//")[0]
            if _re.search(r"\.ProbeModel\b", code) or 'json:"probe_model' in code:
                hits.append(path + ":" + str(i))
    return hits

check("the ProviderConfig struct has no ProbeModel field (code lines)",
      not grep_probe_field(), str(grep_probe_field()[:3]))

# 5. the static price/context tables are dead
check("no priceRules (the curated $/M table)",
      not grep_go(r'priceRules'))
check("no ctxRules (the curated context table)",
      not grep_go(r'var ctxRules'))

# 6. the live laws live where they should
js_ok = "LookupDevModel(provider, rawModel)" in open("engine/internal/llm/effort.go", encoding="utf-8").read()
check("effort.go resolves through the LIVE registry (LookupDevModel)", js_ok)
occ = open("engine/internal/llm/opencode_free.go", encoding="utf-8").read()
check("the free dispatch reads the live registry's cost law",
      "LookupDevModel" in occ and "big-pickle" not in occ)
turn = open("engine/internal/server/ocserveturn.go", encoding="utf-8").read()
check("THE VARIANT LAW rides the serve turn (the #variant suffix)",
      '"#" + v.ID' in turn and "LiveCatalog()" in turn)
mb = open("engine/internal/llm/modelsdev_live.go", encoding="utf-8").read()
check("the live registry is the only models.dev source (no embed)",
      "//go:embed" not in mb and "models.dev/api.json" in mb)

# 7. the brain catalogs never reach the serving path (/api/models is Go-only)
models_go = open("engine/internal/server/models.go", encoding="utf-8").read()
check("/api/models NEVER proxies the brain",
      "BuildCatalogV2" in models_go and "s.brain" not in models_go)

print()
if fails:
    print("v1554 zero-static pins: " + str(len(fails)) + " FAIL")
    sys.exit(1)
print("v1554 zero-static pins: PASS")
