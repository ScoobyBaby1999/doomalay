#!/usr/bin/env python3
# v1390-theme-gaps.py — THE THEME-SET GAP REPORT (STEP 5 of the audit).
#
# Answers hypothesis 3: is any variable defined for only SOME themes, or
# READ anywhere but DEFINED nowhere (the var() fallback trap)?
#
# Sources of truth parsed:
#   index.html   — :root + [data-theme] blocks (the CSS definition surface)
#   theme.js     — THEMES meta (grid palettes/schemes), TRIPLET_VARS,
#                  DERIVED_MIXES, FIELDS, FALLBACKS (the JS definition
#                  surface + the applyTheme write set)
#   formatter.js — SCHEMES (the fmt slot set)
#   *.js         — the READ surface: getPropertyValue('--x') + var(--x)

import os
import re
import sys
from collections import defaultdict

WEB = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                   '..', 'engine', 'internal', 'server', 'web')

VAR_RE = re.compile(r'--([a-zA-Z0-9-]+)')

def parse_blocks():
    """index.html → ({theme_id: {var: raw_value}}, order) with 'root' first."""
    text = open(os.path.join(WEB, 'index.html'), encoding='utf-8').read()
    blocks = {}
    order = []
    cur = None
    depth = 0
    for line in text.split('\n'):
        code = re.sub(r'/\*.*?\*/', '', line)
        code = re.sub(r'//.*$', '', code)
        if cur is None:
            m = re.search(r':root\s*\{', code)
            m2 = re.search(r'\[data-theme="([a-z]+)"\]\s*\{', code)
            if m2:
                cur = m2.group(1); depth = code.count('{') - code.count('}')
                blocks.setdefault(cur, {}); order.append(cur)
            elif m and ':root' in code:
                cur = 'root'; depth = code.count('{') - code.count('}')
                blocks.setdefault(cur, {}); order.append(cur)
            continue
        for vm in re.finditer(r'(--[a-zA-Z0-9-]+)\s*:\s*([^;]+);', code):
            blocks[cur][vm.group(1)] = vm.group(2).strip()
        depth += code.count('{') - code.count('}')
        if depth <= 0:
            cur = None
    return blocks, order

def parse_theme_js():
    text = open(os.path.join(WEB, 'theme.js'), encoding='utf-8').read()
    out = {}
    # THEMES ids
    m = re.search(r'var THEMES = \{(.*?)\n  \};', text, re.S)
    ids = re.findall(r'^\s{4}([a-z]+):\s*\{', m.group(1), re.M) if m else []
    out['theme_ids'] = ids
    # per-theme grid palette keys
    out['grid_keys'] = {}
    for tm in re.finditer(r'^\s{4}([a-z]+):\s*\{ label.*?grid:\s*\{([^}]*)\}', text, re.M | re.S):
        out['grid_keys'][tm.group(1)] = re.findall(r'(\w+):', tm.group(2))
    # TRIPLET_VARS
    m = re.search(r'var TRIPLET_VARS = \{(.*?)\};', text, re.S)
    out['triplet_vars'] = re.findall(r"'(--[a-z0-9-]+)':", m.group(1)) if m else []
    # DERIVED_MIXES
    m = re.search(r'var DERIVED_MIXES = \{(.*?)\n  \};', text, re.S)
    out['derived'] = re.findall(r"'(--[a-z0-9-]+)':", m.group(1)) if m else []
    # FALLBACKS keys
    m = re.search(r'FALLBACKS: \{(.*?)\n      \},', text, re.S)
    out['fallbacks'] = re.findall(r'(\w+):', m.group(1)) if m else []
    # FIELDS (the write set)
    m = re.search(r'var FIELDS = \[(.*?)\];', text, re.S)
    out['fields'] = re.findall(r"field:\s*'(--[a-z0-9-]+)'", m.group(1)) if m else []
    return out

def parse_formatter():
    text = open(os.path.join(WEB, 'formatter.js'), encoding='utf-8').read()
    m = re.search(r'var SCHEMES = \{(.*?)\n  \};', text, re.S)
    schemes = {}
    if m:
        for sm in re.finditer(r'^\s{4}([a-z]+): \{\s*\n\s*label:.*?\n(.*?)\n\s*\},', m.group(1), re.M | re.S):
            slots = re.findall(r'(\w+):\s*\'', sm.group(2))
            schemes[sm.group(1)] = slots
    return schemes

def read_surface():
    """Every '--x' read via getPropertyValue or var() across the tree."""
    reads = defaultdict(set)   # var → files reading it
    for root, dirs, names in os.walk(WEB):
        if 'vendor' in root:
            continue
        for n in names:
            if not n.endswith(('.js', '.html')):
                continue
            p = os.path.join(root, n)
            rel = os.path.relpath(p, WEB)
            text = open(p, encoding='utf-8', errors='replace').read()
            for m in re.finditer(r"getPropertyValue\(\s*'(--[a-z0-9-]+)'", text):
                reads[m.group(1)].add(rel)
            for m in re.finditer(r'var\(\s*(--[a-zA-Z0-9-]+)', text):
                reads[m.group(1)].add(rel)
    return reads

def main():
    blocks, order = parse_blocks()
    tj = parse_theme_js()
    schemes = parse_formatter()
    reads = read_surface()

    theme_ids = [t for t in order if t != 'root']
    print('== CSS blocks: %s ==' % ', '.join(order))
    print('== theme.js THEMES: %s ==' % ', '.join(tj['theme_ids']))
    mismatch = set(theme_ids) ^ set(tj['theme_ids'])
    print('   id-set mismatch CSS vs JS: %s' % (sorted(mismatch) or 'NONE'))
    print()

    # ── 1. per-theme definition counts: which vars ride in SOME blocks ──
    all_vars = set()
    for t in order:
        all_vars |= set(blocks[t])
    print('== VARS NOT DEFINED IN EVERY THEME BLOCK (override coverage) ==')
    for v in sorted(all_vars):
        holders = [t for t in theme_ids if v in blocks[t]]
        in_root = v in blocks['root']
        if len(holders) == len(theme_ids) and in_root:
            continue
        note = ''
        if in_root:
            note = '(root default exists)'
        print('  %-22s %d/10 themes %-24s %s' % (
            v, len(holders), note, ','.join(holders) if len(holders) < 10 else ''))
    print()

    # ── 2. grid palettes: 4 keys per theme? ──
    print('== GRID PALETTES (theme.js THEMES meta) ==')
    want = ['bg', 'line', 'dot', 'origin']
    for t in tj['theme_ids']:
        keys = tj['grid_keys'].get(t, [])
        miss = [k for k in want if k not in keys]
        if miss:
            print('  %s MISSING: %s' % (t, miss))
    print('  (silence above = all 10 themes carry all 4 grid keys)')
    print()

    # ── 3. fmt schemes: 5 slots per scheme? ──
    print('== FMT SCHEMES (formatter.js) ==')
    slotset = None
    for s, slots in sorted(schemes.items()):
        if slotset is None:
            slotset = set(slots)
        elif set(slots) != slotset:
            print('  %s slot drift: %s' % (s, set(slots) ^ slotset))
    print('  %d schemes; slot sets identical: %s; slots=%s' % (
        len(schemes), 'YES' if slotset else '?', sorted(slotset or [])))
    print()

    # ── 4. read-but-never-defined (the fallback trap) ──
    defined = set(all_vars)
    # vars that JS WRITES at runtime (applyTheme's want set + the writers)
    js_written = set()
    for root, dirs, names in os.walk(WEB):
        if 'vendor' in root:
            continue
        for n in names:
            if not n.endswith('.js'):
                continue
            text = open(os.path.join(root, n), encoding='utf-8', errors='replace').read()
            for m in re.finditer(r"setProperty\(\s*'(--[a-z0-9-]+)'", text):
                js_written.add(m.group(1))
            for m in re.finditer(r"'(--[a-z0-9-]+)':", text):
                js_written.add(m.group(1))
    # template/parameterized names are not real vars
    templateish = re.compile(r'^(X|field-X|accent-N|on-accent-N|on-surface-N|d|p|sm|none|x|custom|chat|checkin|mine|up|use|del|rm|kp|kpc|thr|stages|bunch|heart|zone|tall)$')
    print('== READ BUT NEVER DEFINED (CSS block or JS writer) ==')
    gaps = []
    for v in sorted(reads):
        if v in defined or v in js_written:
            continue
        if templateish.match(v.lstrip('-')) or v.startswith(('-wb-',)):
            continue
        gaps.append(v)
    if not gaps:
        print('  NONE — every var() read resolves from a definition surface')
    for v in gaps:
        print('  --%s  read in: %s' % (v, ', '.join(sorted(reads[v])[:4])))
    print()

    # ── 5. defined but never read (dead vars) ──
    print('== DEFINED (any theme block / :root) BUT NEVER READ ==')
    dead = []
    for v in sorted(defined):
        if v in reads:
            continue
        # triplet/derived sources are READ via resolvedThemeVar/FieldMath paths
        # — theme.js reads them through the block cache, not getPropertyValue
        dead.append(v)
    print('  %s' % (', '.join(dead) if dead else 'NONE'))
    print()

    # ── 6. theme.js write-set sanity: TRIPLET/DERIVED/FIELDS ──
    print('== theme.js WRITE SET ==')
    print('  FIELDS:        %s' % ', '.join(tj['fields']))
    print('  DERIVED_MIXES: %s' % ', '.join(tj['derived']))
    print('  TRIPLET_VARS:  %s' % ', '.join(tj['triplet_vars']))
    print('  FALLBACKS:     %s' % ', '.join(tj['fallbacks']))

if __name__ == '__main__':
    main()
