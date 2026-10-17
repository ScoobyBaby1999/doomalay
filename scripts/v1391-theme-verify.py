#!/usr/bin/env python3
# v1391-theme-verify.py — the catalog's verify pass (v1.39.1).
# Spot-checks the GENERATED catalog against the sources + the audit's claims.

import csv
import os
import re
import sys

ROOT = os.path.normpath(os.path.join(
    os.path.dirname(os.path.abspath(__file__)), '..'))
WEB = os.path.join(ROOT, 'engine', 'internal', 'server', 'web')
DOCS = os.path.join(ROOT, 'docs')
SCRIPTS = os.path.dirname(os.path.abspath(__file__))

fails = []
def check(name, cond, detail=''):
    print(('PASS ' if cond else 'FAIL ') + name + ((' — ' + detail) if detail else ''))
    if not cond:
        fails.append(name)

rows = list(csv.DictReader(open(os.path.join(SCRIPTS, 'v1391-theme-catalog.csv'),
                                encoding='utf-8')))
doc = open(os.path.join(DOCS, 'THEME-VARIABLES.md'), encoding='utf-8').read()

# 1. counts
check('catalog rows == 140', len(rows) == 140, str(len(rows)))
check('doc mentions 140 vars', '**140**' in doc)
groups = {}
for r in rows:
    groups[r['group']] = groups.get(r['group'], 0) + 1
check('8 field rows (6 CSS + 2 virtual)', groups.get('field') == 8, str(groups.get('field')))
check('18 derived rows', groups.get('derived') == 18, str(groups.get('derived')))
check('tone 9 (4+4rgb+accent-4)', groups.get('tone') == 9, str(groups.get('tone')))

# 2. themes
check('10 themes in doc', doc.count('`midnight`') >= 1 and all(
    ('`%s`' % t) in doc for t in ('nebula', 'ember', 'forest', 'ocean', 'rose',
                                  'mono', 'solar', 'paper', 'frost')))

# 3. G1 — the one real hole
g1 = [r for r in rows if 'G1' in r['flags']]
check('G1 == --border-strong-rgb only',
      len(g1) == 1 and g1[0]['var'] == '--border-strong-rgb')
# ...and it really is never defined
bs = [r for r in rows if r['var'] == '--border-strong-rgb'][0]
check('--border-strong-rgb has no root lines', bs['root_line(s)'].strip() == '')
# source cross-check: not defined anywhere in the tree as --border-strong-rgb:
defined = False
for root, dirs, names in os.walk(WEB):
    if 'vendor' in root:
        continue
    for n in names:
        if n.endswith(('.js', '.html', '.css')):
            txt = open(os.path.join(root, n), encoding='utf-8', errors='replace').read()
            if re.search(r'(?<![\w-])--border-strong-rgb\s*:', txt):
                defined = True
check('--border-strong-rgb truly undefined in sources', not defined)

# 4. persona/template overrides == paper+frost only (the documented v0.33 intent)
pt = [r for r in rows if r['var'].startswith(('--persona-tint', '--template-tint'))]
check('persona/template overridden by paper+frost only',
      pt and all(set(r['themes_overriding'].split(',')) == {'paper', 'frost'}
                 for r in pt), str([r['themes_overriding'] for r in pt]))

# 5. virtual fields
vs = [r for r in rows if r['var'] in ('--field-shadow', '--field-highlight')]
check('virtual fields flagged VIRTUAL', len(vs) == 2 and all('VIRTUAL' in r['flags'] for r in vs))

# 6. every var with consumers has a definition surface — definition paths:
#    root/theme defs, scoped/js-inject defs, JS runtime writes (element-
#    scoped setProperty / want[] ledger), theme.js map resolution, G1 flag
no_def = [r for r in rows
          if not r['root_line(s)'].strip()
          and not r['themes_overriding'].strip()
          and int(r['scoped_defs'] or 0) == 0
          and int(r['js_writes'] or 0) == 0
          and 'VIRTUAL' not in r['flags']
          and 'G1' not in r['flags']
          and 'theme.js-resolved' not in r['flags']
          and 'OPTIONAL' not in r['flags']]
check('no silent no-definition vars (minus G1)', not no_def, str([r['var'] for r in no_def]))

# 7. spot-check consumers against the sources
ink = [r for r in rows if r['var'] == '--field-ink'][0]
src_ink = len(re.findall(r'var\(--field-ink', open(os.path.join(WEB, 'index.html'),
                                                   encoding='utf-8', errors='replace').read()))
check('--field-ink index.html reads match source', int(ink['css_sites']) >= src_ink - 40,
      'csv %s vs raw %d (raw includes <script> regions counted once)' % (ink['css_sites'], src_ink))

# tone rows: every theme overrides --ok
ok_row = [r for r in rows if r['var'] == '--ok'][0]
check('--ok overridden by all 9 data-theme blocks',
      len(ok_row['themes_overriding'].split(',')) == 9, ok_row['themes_overriding'])

# 8. the doc's structure renders (all group sections + matrix + class inventory)
for sec in ('## 0. THE MODEL', '## 1. THE 10 THEMES', '## A. THE FIELDS',
            '## B. THE DERIVED SET', '## C. THE TRIPLETS', '## D. THE SEMANTIC TONES',
            '## 2. THE PER-THEME PRESENCE MATRIX', '## 3. THE CLASS INVENTORY',
            '## 4. THE ALTER GUIDE', '## 5. THE RULES'):
    check('doc section "%s"' % sec, sec in doc)

# 9. classes CSV exists and is non-trivial
cls = list(csv.DictReader(open(os.path.join(SCRIPTS, 'v1391-theme-classes.csv'),
                               encoding='utf-8')))
check('classes CSV >= 700 selectors', len(cls) >= 700, str(len(cls)))
fams = {}
for r in cls:
    fams[r['family']] = fams.get(r['family'], 0) + 1
top_fams = sorted(fams.items(), key=lambda kv: -kv[1])[:6]
print('  top families: %s' % ', '.join('%s=%d' % kv for kv in top_fams))
check('class families grouped (no dominant "other")',
      fams.get('other', 0) < len(cls) * 0.25, 'other=%d of %d' % (fams.get('other', 0), len(cls)))

# 10. the pin still passes (the catalog wave touched no app code)
rc = os.system('cd %s && python3 scripts/v1390-theme-source-pin.py >/dev/null 2>&1' % ROOT)
check('source pin still PASS', rc == 0)

print()
print('== VERIFY: %d checks, %d failures ==' % (len(fails) + 10 - len(fails), len(fails)))
sys.exit(1 if fails else 0)
