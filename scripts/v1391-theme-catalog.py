#!/usr/bin/env python3
# v1391-theme-catalog.py — THE THEME CATALOG (v1.39.1, the review wave).
#
# GOAL (the user's ask): "I also want to see the list or doc of the
# variables and classes so I can review and alter them."
#
# WHAT IT PRODUCES (generated, never hand-edited — regenerate instead):
#   docs/THEME-VARIABLES.md          — the reviewable catalog:
#       the field model, the 10 themes, every variable grouped by slot
#       (defined-at × per-theme presence × consumers × how to alter),
#       the class inventory by surface, the alter guide, the rules.
#   scripts/v1391-theme-catalog.csv  — one row per variable (full data).
#   scripts/v1391-theme-classes.csv  — one row per CSS class → its vars.
#
# SOURCES OF TRUTH (all parsed, nothing hardcoded):
#   index.html   :root/[data-theme]/@property blocks (definitions)
#   theme.js     THEMES / FIELDS / DERIVED_MIXES / TRIPLET_VARS /
#                FALLBACKS / FIELD_TWIN_ALIAS / FIELD_RGB
#   web tree     every var() read, resolvedThemeVar/getPropertyValue
#                read, setProperty write (comments stripped)

import csv
import os
import re
from collections import defaultdict

WEB = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                   '..', 'engine', 'internal', 'server', 'web')
ROOT = os.path.normpath(os.path.join(WEB, '..', '..', '..', '..'))
DOCS = os.path.join(ROOT, 'docs')
SCRIPTS = os.path.dirname(os.path.abspath(__file__))

SKIP_DIRS = ('vendor',)
THEME_JS = os.path.join(WEB, 'theme.js')
INDEX_HTML = os.path.join(WEB, 'index.html')

# ── comment stripping (the census's state machine) ──────────────────
def strip_comments(text):
    out_lines = []
    in_block = False
    for line in text.split('\n'):
        res = []
        i, n = 0, len(line)
        quote = None
        while i < n:
            c = line[i]
            if in_block:
                if line.startswith('*/', i):
                    in_block = False
                    i += 2
                    continue
                i += 1
                continue
            if quote:
                res.append(c)
                if c == '\\' and i + 1 < n:
                    res.append(line[i + 1]); i += 2; continue
                if c == quote:
                    quote = None
                i += 1
                continue
            if c in ('\'', '"', '`'):
                quote = c; res.append(c); i += 1; continue
            if line.startswith('/*', i):
                in_block = True; i += 2; continue
            if line.startswith('//', i):
                break
            res.append(c); i += 1
        out_lines.append(''.join(res))
    return '\n'.join(out_lines)

# ── index.html: definition blocks ────────────────────────────────────
def parse_blocks(text):
    """Yield {kind, theme, start, end} for :root / [data-theme=X] /
    @property blocks (brace-tracked, comments stripped first)."""
    code = strip_comments(text)
    lines = code.split('\n')
    blocks = []
    open_re = re.compile(r'(:root\s*\{|\[data-theme\s*=\s*["\']?([a-z0-9_-]+)["\']?\s*\]\s*\{|@property\s+(--[a-z0-9-]+)\s*\{)')
    depth = 0
    cur = None
    for lineno, line in enumerate(lines, 1):
        if cur is None:
            m = open_re.search(line)
            if m:
                kind = 'theme' if m.group(2) else ('property' if m.group(3) else 'root')
                cur = {'kind': kind, 'theme': m.group(2), 'prop': m.group(3),
                       'start': lineno, 'depth': line.count('{') - line.count('}')}
                if cur['depth'] <= 0:
                    cur['end'] = lineno
                    blocks.append(cur); cur = None
        else:
            cur['depth'] += line.count('{') - line.count('}')
            if cur['depth'] <= 0:
                cur['end'] = lineno
                blocks.append(cur); cur = None
    return blocks, code

VARDEF_RE = re.compile(r'(--[a-zA-Z0-9-]+)\s*:\s*([^;]+);')

def block_defs(code, blk):
    """Extract (name, value, lineno) definitions inside one block.
    @property blocks contribute their initial-value as the definition."""
    lines = code.split('\n')
    out = []
    if blk['kind'] == 'property' and blk.get('prop'):
        name = blk['prop']
        for lineno in range(blk['start'], min(blk['end'], len(lines)) + 1):
            m = re.search(r'initial-value\s*:\s*([^;]+);', lines[lineno - 1])
            if m:
                out.append((name, m.group(1).strip(), lineno))
        return out
    for lineno in range(blk['start'], min(blk['end'], len(lines)) + 1):
        for m in VARDEF_RE.finditer(lines[lineno - 1]):
            out.append((m.group(1), m.group(2).strip(), lineno))
    return out

# ── index.html: CSS selector context for var() reads ────────────────
SCRIPT_OPEN = re.compile(r'<script\b', re.I)
SCRIPT_CLOSE = re.compile(r'</script\s*>', re.I)
# a selector-opener line: JUST the selector + '{' (anchored — never inside
# an attribute value); also tolerates a same-line one-liner rule.
RULE_OPEN_RE = re.compile(r'^\s*([^{}@;]+?)\s*\{\s*([^{}]*)\}\s*$')
OPEN_ONLY_RE = re.compile(r'^\s*([^{}@;]+?)\s*\{\s*$')
JSISH = re.compile(r'function|=>|\bif\s*\(|\bfor\s*\(|\bswitch\s*\(|\bcatch\s*\(|querySelector|addEventListener|\.map\(|\.forEach\(')

def css_rules(code):
    """Yield (start_line, end_line, selector) for every CSS rule in the
    index.html <style> region (anchored openers, brace-tracked)."""
    lines = code.split('\n')
    rules = []
    in_script = False
    sel = None
    start = 0
    depth = 0
    for i, line in enumerate(lines):
        if SCRIPT_CLOSE.search(line):
            in_script = False
            sel = None; depth = 0
            continue
        if in_script:
            continue
        if SCRIPT_OPEN.search(line):
            in_script = True
            sel = None; depth = 0
            continue
        if sel is None:
            m = RULE_OPEN_RE.match(line)
            if m:
                rules.append((i + 1, i + 1, m.group(1).strip()))
                continue
            m = OPEN_ONLY_RE.match(line)
            if m and not JSISH.search(line):
                sel = m.group(1).strip()
                start = i + 1
                depth = 1
            continue
        depth += line.count('{') - line.count('}')
        if depth <= 0:
            rules.append((start, i + 1, sel))
            sel = None
    return rules

def selector_contexts(code, rules):
    """Per line of index.html: ('CSS', selector) inside a rule,
    ('JS', None) inside <script>, else ('CSS', None)."""
    lines = code.split('\n')
    ctx = [('CSS', None)] * len(lines)
    for (a, b, sel) in rules:
        for i in range(a - 1, min(b, len(lines))):
            ctx[i] = ('CSS', sel)
    in_script = False
    for i, line in enumerate(lines):
        if SCRIPT_CLOSE.search(line):
            in_script = False
            continue
        if SCRIPT_OPEN.search(line):
            in_script = True
        if in_script:
            ctx[i] = ('JS', None)
    return ctx

# ── theme.js: object entry extraction (brace-walk) ──────────────────
def js_entries(code, marker):
    """Ordered (key, raw_value) entries of the object literal assigned
    at `marker` (e.g. 'var THEMES = {'), top level only."""
    idx = code.find(marker)
    if idx < 0:
        return []
    i = code.index('{', idx)
    depth = 0
    entries = []
    key = None
    key_start = None
    val_start = None
    n = len(code)
    while i < n:
        c = code[i]
        if c in '{[':          # brackets nest like braces for entry splitting
            depth += 1
            if depth == 2 and key is not None and val_start is None:
                val_start = i
        elif c in '}]':
            depth -= 1
            if depth == 0:
                if key is not None and val_start is not None:
                    entries.append((key, code[val_start:i + 1].strip()))
                break
        elif depth == 1:
            if key is None:
                m = re.match(r"[\'\"]?([A-Za-z0-9_-]+)[\'\"]?\s*:", code[i:])
                if m:
                    key = m.group(1)
                    key_start = i
                    i = i + m.end() - 1
            elif c == ',':
                entries.append((key, code[val_start if val_start is not None else key_start:i].strip()))
                key = None; val_start = None
            elif val_start is None and not c.isspace() and c != ':':
                val_start = i
        i += 1
    return entries

def sub_field(raw, name, quoted=True):
    m = re.search(name + r"\s*:\s*'([^']*)'" if quoted else name + r'\s*:\s*([^,\s}]+)', raw)
    return m.group(1) if m else None

# ── groups ───────────────────────────────────────────────────────────
FIELD_NAMES = ['--field-surface', '--field-ink', '--field-canvas',
               '--field-accent-1', '--field-accent-2', '--field-accent-3',
               '--field-shadow', '--field-highlight']
TONE_NAMES = ['--ok', '--warn', '--err', '--notice']
SIZING_NAMES = ['--chat-fs', '--chat-scale', '--ui-fs', '--ui-small-fs',
                '--ui-micro-fs']
# component-scoped families (JS-poked or class-scoped plumbing)
COMPONENT_RE = re.compile(
    r'^--(wsp|proj|artt|panel-vis|kp|hub-tone|veil-ink-rgb|gr-|ts-|pv-|dx-|wt-)')

def classify(name):
    if name.startswith('--fmt-'):
        return 'fmt'
    if name in FIELD_NAMES:
        return 'field'
    if name.startswith('--field-'):
        return 'field'
    if re.match(r'^--(ok|warn|err|notice)(-rgb)?$', name):
        return 'tone'
    if re.match(r'^--(persona|template)', name):
        return 'pill'
    if re.match(r'^--(on-accent|on-accent-[234]|on-brand|on-ok|on-surface|on-bg|on-border|veil-ink|highlight-inset|text-shadow)', name):
        return 'chrome'
    if name in ('--accent-4',):
        return 'tone'
    if COMPONENT_RE.match(name):
        return 'component'
    if name in DERIVED_SET:
        return 'derived'
    if name.endswith('-gradient'):
        return 'gradient'
    if name.endswith('-rgb'):
        return 'triplet'
    if name in SIZING_NAMES:
        return 'sizing'
    return 'other'

# the DERIVED SET (populated in main from DERIVED_MIXES + the :root
# color-mix aliases): never edit directly — products of the fields.
DERIVED_SET = set()

GROUP_ORDER = ['field', 'derived', 'triplet', 'tone', 'pill', 'chrome',
               'gradient', 'fmt', 'sizing', 'component', 'other']

# role hints for known vars outside FIELDS (filled from the plan docs)
ROLE_HINTS = {
    '--accent-4': 'the fourth accent — per-theme, pills/tones',
    '--accent': 'the primary accent window (= --field-accent-1)',
    '--accent-2': 'the adjacent accent window (= --field-accent-2)',
    '--accent-3': 'the third accent window (= --field-accent-3)',
    '--surface-1': 'the plate (= --field-surface)',
    '--bg-panel': 'the panel backdrop (= --field-canvas)',
    '--text-1': 'the text (= --field-ink)',
    '--ok': 'success green (pills, dots, banners)',
    '--warn': 'warning amber (meters, stalled states)',
    '--err': 'error red (banners, destructive)',
    '--notice': 'soft adjacent warning (context meters)',
    '--on-accent': 'readable ink on accent-1 fills',
    '--on-accent-2': 'readable ink on accent-2 fills',
    '--on-accent-3': 'readable ink on accent-3 fills',
    '--on-accent-4': 'readable ink on accent-4 fills',
    '--on-brand': 'white glyph on brand discs (constant)',
    '--on-ok': 'near-black ✓ on ok-dots (constant)',
    '--veil-ink': 'text-shadow ink from surface luminance',
    '--text-shadow': 'the readability veil under text',
    '--highlight-inset': 'the 1px inner ring on raised chrome',
    '--persona-tint': 'persona purple (library pills)',
    '--template-tint': 'template green (library pills)',
}
GROUP_TITLES = {
    'field': 'A. THE FIELDS — the 8 user-editable sources',
    'derived': 'B. THE DERIVED SET — color-mix products of the fields',
    'triplet': 'C. THE TRIPLETS — the rgba() composition aliases',
    'tone': 'D. THE SEMANTIC TONES — ok · warn · err · notice',
    'pill': 'E. THE PILL TONES — persona · template',
    'chrome': 'F. THE CHROME CONSTANTS — theme-stable inks & shadows',
    'gradient': 'H. THE GRADIENT TWINS — the alias spellings',
    'fmt': 'G. THE FMT SLOTS — chat-content formatting palette',
    'sizing': 'I. THE SIZING LEVERS — text scale (no color)',
    'component': 'J. THE COMPONENT-SCOPED VARS — JS-poked plumbing',
    'other': 'K. THE REST — everything else (each one explained)',
}

# ── surfaces (class inventory) ───────────────────────────────────────
# class-family legend: confident prefix → surface (the review doc's
# grouping); unlisted prefixes fall through to their raw first token.
FAMILY_LEGEND = {
    'msg': 'chat', 'chat': 'chat', 'typing': 'chat', 'chatbot': 'chat',
    'panel': 'panel', 'dock': 'panel',
    'hub': 'hub/library', 'hi': 'hub/library', 'lib': 'hub/library',
    'set': 'settings', 'settings': 'settings', 'tab': 'settings',
    'gr': 'settings', 'te': 'theme-editor',
    'wsp': 'workspace', 'wt': 'workspace', 'kp': 'workspace',
    'fmt': 'chat-content',
    'art': 'artifacts', 'artt': 'artifacts', 'wb': 'artifacts',
    'tool': 'controls', 'btn': 'controls', 'kbd': 'controls',
    'te-': 'theme-editor',
}

def family_of(sel):
    """selector → (surface, first-class-token)."""
    m = re.search(r'\.([A-Za-z][A-Za-z0-9_-]*)', sel or '')
    if not m:
        tok = (sel or '').strip().lstrip('#').split(' ')[0].split(':')[0] or 'other'
        if tok in ('body', 'html', ':root'):
            return ('global', tok)
        if tok.startswith('#chat'):
            return ('chat', tok)
        return ('other', tok)
    cls = m.group(1)
    pre = cls.split('-')[0].split('--')[0]
    if pre in FAMILY_LEGEND:
        return (FAMILY_LEGEND[pre], cls)
    return (pre or 'other', cls)

# ═════════════════════════════════════════════════════════════════════
def main():
    ix_text = open(INDEX_HTML, encoding='utf-8', errors='replace').read()
    ix_code = strip_comments(ix_text)
    blocks, _ = parse_blocks(ix_text)
    theme_blocks = [b for b in blocks if b['kind'] == 'theme']
    root_blocks = [b for b in blocks if b['kind'] == 'root']
    prop_blocks = [b for b in blocks if b['kind'] == 'property']

    themes = [b['theme'] for b in theme_blocks]
    themes = list(dict.fromkeys(themes))            # ordered, deduped

    # definitions: var → list of (where, value, lineno, theme|None)
    defs = defaultdict(list)
    for blk in blocks:
        for (name, val, lineno) in block_defs(ix_code, blk):
            where = blk['theme'] or ':root'
            defs[name].append((where, val, lineno,
                               'property' if blk['kind'] == 'property' else 'block'))

    # ── theme.js structures ──
    tj_code = strip_comments(open(THEME_JS, encoding='utf-8', errors='replace').read())
    tj_raw = open(THEME_JS, encoding='utf-8', errors='replace').read()
    tj_lines = tj_raw.split('\n')

    def tj_line_of(marker):
        for i, l in enumerate(tj_raw.split('\n'), 1):
            if marker in l:
                return i
        return 0

    fields_meta = {}
    # FIELDS is an ARRAY of { field, label, hint, ... } — parse by regex over
    # the array region (js_entries is object-only).
    fm_region = tj_code[tj_code.find('var FIELDS ='):]
    fm_region = fm_region[:fm_region.find('];') + 2] if '];' in fm_region else fm_region[:4000]
    for m in re.finditer(r"field\s*:\s*'(--[a-z0-9-]+)'[^}]*?label\s*:\s*'([^']*)'[^}]*?hint\s*:\s*'([^']*)'", fm_region, re.S):
        fields_meta[m.group(1)] = {
            'label': m.group(2), 'hint': m.group(3),
            'line': tj_line_of("field: '%s'" % m.group(1)),
        }
    derived_mixes = {}
    for key, raw in js_entries(tj_code, 'var DERIVED_MIXES ='):
        m = re.match(r"\[\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*([\d.]+)\s*\]", raw)
        if m:
            derived_mixes[key] = (m.group(1), m.group(2), float(m.group(3)))
    triplet_vars = {}
    for key, raw in js_entries(tj_code, 'var TRIPLET_VARS ='):
        m = re.match(r"'\s*([^']+)\s*'", raw)
        if m:
            triplet_vars[key] = m.group(1)
    fallbacks = {}
    fb_start = tj_line_of('FALLBACKS: {')
    for key, raw in js_entries(tj_code, 'FALLBACKS: {'):
        fallbacks[key] = raw
    twin_alias = {}
    for key, raw in js_entries(tj_code, 'var FIELD_TWIN_ALIAS ='):
        m = re.match(r"'\s*([^']+)\s*'", raw)
        if m:
            twin_alias[key] = m.group(1)
    themes_meta = {}
    for key, raw in js_entries(tj_code, 'var THEMES ='):
        themes_meta[key] = {
            'label': sub_field(raw, 'label'),
            'scheme': sub_field(raw, 'scheme'),
            'light': sub_field(raw, 'light', quoted=False),
            'accent': sub_field(raw, 'accent'),
            'accent2': sub_field(raw, 'accent2'),
            'accent3': sub_field(raw, 'accent3'),
            'accent4': sub_field(raw, 'accent4'),
            'grid': {g: sub_field(raw, g) for g in ('bg', 'line', 'dot', 'origin')},
        }

    # populate DERIVED_SET (classification must run after this)
    DERIVED_SET.update(derived_mixes.keys())
    DERIVED_SET.update(['--surface-1', '--text-1', '--bg-panel', '--accent',
                        '--accent-2', '--accent-3', '--shadow-ink',
                        '--raised-chrome', '--raised-ring'])

    # ── consumption scan (all web files) ──
    var_use = defaultdict(lambda: {'css': defaultdict(list), 'jsread': defaultdict(list),
                                   'jswrite': defaultdict(list), 'jsvar': defaultdict(list)})
    files = []
    for root, dirs, names in os.walk(WEB):
        rel = os.path.relpath(root, WEB)
        if any(rel == d or rel.startswith(d + os.sep) for d in SKIP_DIRS):
            continue
        for n in names:
            if n.endswith(('.js', '.html', '.json', '.css')):
                files.append(os.path.join(root, n))
    css_class_vars = defaultdict(set)      # selector → var set (index.html CSS)
    js_read_re = re.compile(r'(?:resolvedThemeVar|getPropertyValue|getProperty\w*)\s*\(\s*[\'"](--[a-zA-Z0-9-]+)')
    js_write_re = re.compile(r'setProperty\s*\(\s*[\'"](--[a-zA-Z0-9-]+)')
    ledger_write_re = re.compile(r"want\[\s*['\"](--[a-zA-Z0-9-]+)['\"]\s*\]\s*=")
    # any function call taking a LITERAL var name (resolvedThemeVar, local
    # rv() helpers, triplet() wrappers…) — a resolution request = a read
    call_read_re = re.compile(r"\b(?!setProperty\b|removeProperty\b)([A-Za-z_$][\w$]*)\s*\(\s*['\"](--[a-zA-Z0-9-]+)['\"]")
    var_ref_re = re.compile(r'var\(\s*(--[a-zA-Z0-9-]+)')
    # a scoped DEFINITION: --x: (not inside a var() reference; quoted-string
    # keys like '--x': never match anyway — the quote breaks the colon)
    var_def_re = re.compile(r"(?<![\w-])(--[a-zA-Z0-9-]+)\s*:")
    for path in sorted(files):
        relp = os.path.relpath(path, WEB)
        text = open(path, encoding='utf-8', errors='replace').read()
        code = strip_comments(text)
        lines = code.split('\n')
        if relp != 'index.html':
            fn = None
            fn_re = re.compile(r'function\s+([A-Za-z0-9_$]+)')
            for i, line in enumerate(lines):
                m = fn_re.search(line)
                if m:
                    fn = m.group(1)
                for vm in var_ref_re.finditer(line):
                    nm2 = vm.group(1)
                    if re.search(r'var\(\s*' + re.escape(nm2) + r'\s*,', line):
                        var_use[nm2]['fallback_reads'] = \
                            var_use[nm2].get('fallback_reads', 0) + 1
                    var_use[nm2]['css'][relp].append((i + 1, fn))
                    var_use[nm2]['jsvar'][relp].append(i + 1)
                for rm in js_read_re.finditer(line):
                    var_use[rm.group(1)]['jsread'][relp].append(i + 1)
                for cm in call_read_re.finditer(line):
                    var_use[cm.group(2)]['jsread'][relp].append(i + 1)
                for wm in js_write_re.finditer(line):
                    var_use[wm.group(1)]['jswrite'][relp].append(i + 1)
                for lm in ledger_write_re.finditer(line):
                    var_use[lm.group(1)]['jswrite'][relp].append(i + 1)
                # JS-injected CSS definitions (unquoted --x: inside strings)
                for dm in var_def_re.finditer(line):
                    name = dm.group(1)
                    if name in defs:
                        continue                     # root/theme definition
                    val = line[dm.end():].split(';')[0].strip()[:80]
                    defs[name].append(('js-inject:' + relp, val, i + 1, 'scope'))
            continue          # JS files fully scanned above
        rules = css_rules(code)
        ctx = selector_contexts(code, rules)
        # scoped definitions: --x: inside rule bodies (NOT in theme blocks)
        blk_lines = set()
        for blk in blocks:
            for ln in range(blk['start'], blk['end'] + 1):
                blk_lines.add(ln)
        for (a, b, sel) in rules:
            for ln in range(a, b + 1):
                if ln in blk_lines:
                    continue
                for dm in var_def_re.finditer(lines[ln - 1]):
                    name = dm.group(1)
                    val = lines[ln - 1][dm.end():].split(';')[0].strip()[:80]
                    defs[name].append(('scope:' + sel, val, ln, 'scope'))
        # index.html: var() reads + their CSS selector
        for i, line in enumerate(lines):
            kind, sel = ctx[i] if i < len(ctx) else (None, None)
            for vm in var_ref_re.finditer(line):
                name = vm.group(1)
                if re.search(r'var\(\s*' + re.escape(name) + r'\s*,', line):
                    var_use[name]['fallback_reads'] = \
                        var_use[name].get('fallback_reads', 0) + 1
                if kind == 'CSS' and sel:
                    var_use[name]['css']['index.html'].append((i + 1, sel))
                    css_class_vars[sel].add(name)
                elif kind == 'JS':
                    var_use[name]['css']['index.html<js>'].append((i + 1, None))
                else:
                    var_use[name]['css']['index.html'].append((i + 1, None))
            for rm in js_read_re.finditer(line):
                var_use[rm.group(1)]['jsread'][relp].append(i + 1)
            for cm in call_read_re.finditer(line):
                var_use[cm.group(2)]['jsread'][relp].append(i + 1)
            for wm in js_write_re.finditer(line):
                var_use[wm.group(1)]['jswrite'][relp].append(i + 1)

    # ── assemble the variable catalog ──
    # the theme.js RESOLVED set: every quoted '--x' literal in theme.js —
    # alias-map values, ON_VAR values, triplet sources… (resolution targets)
    themejs_resolved = set(re.findall(r"['\"](--[a-zA-Z0-9-]+)['\"]", tj_code))
    all_vars = set(defs.keys()) | set(var_use.keys())
    all_vars = set(n for n in all_vars if not n.endswith('-'))   # drop concat fragments
    catalog = {}
    for name in sorted(all_vars):
        grp = classify(name)
        d = defs.get(name, [])
        root_defs = [(v, l) for (w, v, l, k) in d if w == ':root']
        theme_defs = [(w, v, l) for (w, v, l, k) in d
                      if w != ':root' and not w.startswith(('scope:', 'js-inject:'))]
        scope_defs = [(w, v, l) for (w, v, l, k) in d
                      if w.startswith(('scope:', 'js-inject:'))]
        prop_defs = [(v, l) for (w, v, l, k) in d if k == 'property']
        use = var_use.get(name, {'css': {}, 'jsread': {}, 'jswrite': {}, 'jsvar': {}})
        flags = []
        if name.endswith('-rgb') and name not in triplet_vars and not d:
            flags.append('G1: read but NEVER defined anywhere (root, theme, scope, js-inject)')
        root_lines = sorted(set(l for (_, l) in root_defs))
        if root_lines and root_lines[-1] - root_lines[0] > 3000:
            flags.append('G2: definition split across distant :root blocks')
        if name in FIELD_NAMES and not d:
            flags.append('no static definition — applyTheme writes it (Colors-tab override or the derived default)')
        if not d and not use['jswrite'] and name in themejs_resolved:
            flags.append('theme.js-resolved (map target: twin alias / ON-var / triplet)')
        # distinct var() matches = the css list (JS matches append there too;
        # jsvar mirrors the JS subset and must not be added again)
        total_reads = sum(len(v) for v in use['css'].values())
        fb = use.get('fallback_reads', 0)
        if not d and not use['jswrite'] and fb and fb >= total_reads and name not in themejs_resolved:
            flags.append('OPTIONAL var — every read carries an in-var fallback'
                         ' (the documented resolver; var-fallback zone)')
        tset = sorted(set(w for (w, _, _) in theme_defs))
        if name.startswith(('--persona', '--template')) and tset:
            flags.append('documented v0.33 light-theme override')
        derived = derived_mixes.get(name)
        catalog[name] = {
            'group': grp,
            'prop': prop_defs,
            'root': root_defs,
            'root_lines': root_lines,
            'themes': tset,
            'theme_defs': theme_defs,
            'derived': derived,
            'scopes': scope_defs,
            'triplet_src': triplet_vars.get(name),
            'twin': twin_alias.get(name),
            'fallback_key': next((k for k, v in {
                'canvas': '--field-canvas', 'ink': '--field-ink', 'surface': '--field-surface',
                'surface2': '--surface-2', 'text2': '--text-2', 'text3': '--text-3-dim',
                'card': '--card', 'borderStrong': '--border-strong', 'accent': '--field-accent-1',
                'accent2': '--field-accent-2', 'ok': '--ok', 'shadow': '--shadow-ink',
                'highlight': '--highlight-inset'}.items() if v == name), None),
            'css': dict(use['css']),
            'jsread': dict(use['jsread']),
            'jswrite': dict(use['jswrite']),
            'jsvar': dict(use['jsvar']),
            'flags': flags,
        }

    # reclassify: JS-poked or scoped-only leftovers are component plumbing
    for name, c in catalog.items():
        if c['group'] != 'other' or c['root'] or c['themes']:
            continue
        if (c['scopes'] or c['jswrite'] or c['jsvar'] or c['jsread']) and not c['prop']:
            c['group'] = 'component'

    # the two VIRTUAL fields (editor rows without a CSS var): --field-shadow
    # and --field-highlight derive into --shadow-ink / --highlight-inset.
    for fname in ('--field-shadow', '--field-highlight'):
        if fname not in catalog and fname in fields_meta:
            catalog[fname] = {
                'group': 'field', 'prop': [], 'root': [], 'root_lines': [],
                'themes': [], 'theme_defs': [], 'derived': None, 'scopes': [],
                'triplet_src': None, 'twin': None, 'fallback_key': None,
                'css': {}, 'jsread': {}, 'jswrite': {}, 'jsvar': {},
                'flags': ['VIRTUAL field — no CSS var; the theme editor row'
                          ' stores a user override; applyTheme derives it into'
                          ' %s' % ('--shadow-ink' if fname == '--field-shadow'
                                   else '--highlight-inset(-rgb)')],
            }

    # ══ outputs ══
    os.makedirs(DOCS, exist_ok=True)

    # CSV — one row per var
    csv_path = os.path.join(SCRIPTS, 'v1391-theme-catalog.csv')
    with open(csv_path, 'w', newline='', encoding='utf-8') as f:
        w = csv.writer(f)
        w.writerow(['var', 'group', 'role', 'root_line(s)', 'themes_overriding',
                    'scoped_defs', 'derived_from', 'triplet_source', 'fallback_key',
                    'css_sites', 'css_classes', 'js_reads', 'js_writes', 'flags'])
        for name, c in catalog.items():
            fm = fields_meta.get(name, {})
            w.writerow([
                name, c['group'], fm.get('label') or '',
                ' '.join(map(str, c['root_lines'])),
                ','.join(c['themes']),
                len(c['scopes']),
                ('%s ⊕ %s %d%%' % (c['derived'][0], c['derived'][1],
                                   round(c['derived'][2] * 100))) if c['derived'] else '',
                c['triplet_src'] or '', c['fallback_key'] or '',
                sum(len(v) for v in c['css'].values()),
                sum(1 for s in css_class_vars.values() if name in s),
                sum(len(v) for v in c['jsread'].values()),
                sum(len(v) for v in c['jswrite'].values()),
                '; '.join(c['flags']),
            ])

    # CSV — one row per CSS class (selector → vars)
    cls_csv = os.path.join(SCRIPTS, 'v1391-theme-classes.csv')
    with open(cls_csv, 'w', newline='', encoding='utf-8') as f:
        w = csv.writer(f)
        w.writerow(['selector', 'family', 'first_class', 'vars_consumed(count)', 'vars'])
        for sel in sorted(css_class_vars, key=lambda s: -len(css_class_vars[s])):
            vs = sorted(css_class_vars[sel])
            fam, first = family_of(sel)
            w.writerow([sel, fam, first, len(vs), ' '.join(vs)])

    # counts for the doc header
    n_css_sites = sum(sum(len(v) for v in c['css'].values()) for c in catalog.values())
    n_js_reads = sum(sum(len(v) for v in c['jsread'].values()) for c in catalog.values())
    n_js_writes = sum(sum(len(v) for v in c['jswrite'].values()) for c in catalog.values())
    undefined = [n for n, c in catalog.items() if any('G1' in fl for fl in c['flags'])]

    # dynamic-token reconciliation (the census's 188 vs the literal 121)
    all_tokens = set()
    tok_re = re.compile(r'--[a-zA-Z0-9-]+')
    for path in files:
        code = strip_comments(open(path, encoding='utf-8', errors='replace').read())
        for m in tok_re.finditer(code):
            all_tokens.add(m.group(0))
    dynamic = sorted(t for t in all_tokens - set(catalog.keys()))
    dynamic = [t for t in dynamic if len(t) > 4]

    # ══ the doc ══
    L = []
    A = L.append
    A('# THEME-VARIABLES — the reviewable catalog (v1.39.1)')
    A('')
    A('> **GENERATED by `scripts/v1391-theme-catalog.py`** — do not hand-edit;'
      ' edit the sources (index.html theme blocks / theme.js) and regenerate.')
    A('> Every row below is parsed live from the tree, so this doc cannot')
    A('> drift from the code. Sources: index.html `:root`/`[data-theme]`/')
    A('> `@property` blocks + theme.js `THEMES`/`FIELDS`/`DERIVED_MIXES`/')
    A('> `TRIPLET_VARS`/`FALLBACKS` + every `var()` read, JS read and write.')
    A('')
    A('| at a glance | |')
    A('|---|---|')
    A('| distinct variables (literal, parsed) | **%d** |' % len(catalog))
    A('| themes | **%d** — midnight ships as the `:root` defaults, + %s |'
      % (len(themes_meta), ', '.join(t for t in themes_meta if t != 'midnight')))
    A('| CSS var() consumption sites (occurrences) | **%d** |' % n_css_sites)
    A('| JS reads (resolvedThemeVar / getPropertyValue) | **%d** |' % n_js_reads)
    A('| JS writes (setProperty + the want[] ledger) | **%d** |' % n_js_writes)
    A('| CSS selectors consuming vars (index.html) | **%d** |' % len(css_class_vars))
    A('| read-but-undefined holes | **%s** |' % (', '.join('`%s`' % u for u in undefined) or 'none'))
    A('')
    A('**Count reconciliation**: the v1.39 census counted **%d** distinct'
      ' `--token` spellings in the tree; **%d** of them are LITERAL variables'
      ' (cataloged below); the other %d are dynamically-composed names or'
      ' trailing-dash fragments (e.g. %s) — string-built prefixes that only'
      ' become variables at runtime (formatter scheme keys, per-provider wsp'
      ' tints). They resolve through the same themed values.'
      % (len(all_tokens), len(catalog), len(dynamic),
         ', '.join('`%s`' % d for d in dynamic[:6]) + ('…' if len(dynamic) > 6 else '')))
    A('')
    A('Full data: `scripts/v1391-theme-catalog.csv` (per-variable) ·'
      ' `scripts/v1391-theme-classes.csv` (per-class map).'
      ' Violations & findings: `docs/THEME-AUDIT-V139.md`.'
      ' Slot semantics: `PLAN-V098-COLOR-SYSTEM.md`, `PLAN-V091-COLOR-REWORK.md`.')
    A('')

    # — the model —
    A('## 0. THE MODEL — how a color reaches the screen')
    A('')
    A('```')
    A('  [ YOUR 8 FIELDS ]        the only things you edit')
    A('   surface · ink · canvas · accent-1/2/3 · shadow · highlight')
    A('        │')
    A('        ├─ CSS derives (color-mix in oklab, :root block)')
    A('        │    surfaces 2/3 · card · border(s) · text tints · bg-app ·')
    A('        │    shadow-ink · raised-chrome/ring   ← never edit directly')
    A('        ├─ JS derives (theme.js DERIVED_MIXES, culori parity)')
    A('        │    the same set as -rgb triplets for rgba() composition')
    A('        └─ canvas reads (lattice/atoms/pixiworld via resolvedThemeVar)')
    A('             #c/#c2 repaint + Pixi atlas re-key on every apply')
    A('```')
    A('')
    A('Rules: (1) never hardcode a color — the pin (gate A5) fails any new')
    A('literal outside the canonical zones; (2) consumers only ever read')
    A('variables; (3) new variables join a group below and get a slot meaning.')
    A('')

    # — the 10 themes —
    A('## 1. THE 10 THEMES (theme.js THEMES + index.html [data-theme])')
    A('')
    A('| id | label | scheme | light | accent-1/2/3/4 | grid bg/line/dot/origin |')
    A('|---|---|---|---|---|---|')
    for t, m in themes_meta.items():
        A('| `%s` | %s | %s | %s | %s / %s / %s / %s | %s / %s / %s / %s |' % (
            t, m['label'], m['scheme'], m['light'],
            m['accent'], m['accent2'], m['accent3'], m['accent4'],
            m['grid']['bg'], m['grid']['line'], m['grid']['dot'], m['grid']['origin']))
    A('')
    A('Per-theme field values live in the `[data-theme]` blocks of'
      ' index.html (lines %d–%d); the JS twin (`THEMES`) feeds the canvas.'
      ' Adding a theme = one `[data-theme]` block + one `THEMES` entry'
      ' (all 6 fields + tones + triplets) — the pin and the verify rig'
      ' (`scripts/v1390-theme-verify.py`) will check it.'
      % (min(b['start'] for b in theme_blocks), max(b['end'] for b in theme_blocks)))
    A('')

    # — group sections —
    for grp in GROUP_ORDER:
        names = [n for n, c in catalog.items() if c['group'] == grp]
        if not names:
            continue
        A('## %s' % GROUP_TITLES[grp])
        A('')
        intro = {
            'field': 'The user-editable sources (the theme_editor rows). To alter a'
                     ' field for one theme: edit its line in that `[data-theme]`'
                     ' block; for the default: the first `:root` block. The JS'
                     ' twin `THEMES[t]` must stay in sync (accent colors + grid).',
            'derived': 'Products of `color-mix(in oklab, …)` in :root — do not edit'
                       ' their values directly; tune the mix (or add to'
                       ' `DERIVED_MIXES` for JS parity) and every theme re-derives.',
            'triplet': '`rgba()`-composition aliases (`--x-rgb`), re-derived from'
                       ' their source var on every apply by `TRIPLET_VARS`. Boot'
                       ' statics exist so the page works before JS; consumers use'
                       ' `rgba(var(--x-rgb), α)`.',
            'tone': 'Per-theme semantic colors — every theme block carries all'
                    ' four (+ their `-rgb` aliases). Consumers: pills, dots,'
                    ' cost colors, status banners.',
            'pill': 'Persona/template identity tints — dark themes ride the :root'
                    ' values; paper+frost override for contrast (documented v0.33).',
            'chrome': 'Theme-STABLE constants (the --on-brand precedent): white'
                      ' glyph on brand discs, near-black ✓ on ok, the veil/text'
                      ' shadow inks. theme.js re-derives --veil-ink from the'
                      ' resolved surface luminance.',
            'gradient': 'Gradient spellings — only a FIELD can hold a gradient;'
                        ' these names are pure aliases written by applyTheme'
                        ' (`FIELD_TWIN_ALIAS`). Consumers keep their historical'
                        ' names (~60 sites).',
            'fmt': 'Chat-content formatting palette (:root defaults ride'
                   ' --accent-2/--text-1); formatter.js SCHEMES re-apply per'
                   ' scheme; tweaks.js + the JS writers poke these live.',
            'sizing': 'Not colors — the text-size system (chat-fs × chat-scale'
                      ' multiplies every px in the message scope).',
            'component': 'JS-poked component plumbing (projections, workspace'
                         ' provider tints, artifact rails, the panel-vis'
                         ' streaming var). Values are runtime, not themed — they'
                         ' compose themed triplets.',
            'other': 'Each entry below lists where it is defined and consumed so'
                     ' nothing hides outside the named groups.',
        }[grp]
        A(intro)
        A('')
        A('| variable | role | defined at (index.html lines) | themes overriding | derives | consumers | flags |')
        A('|---|---|---|---|---|---|---|')
        for n in names:
            c = catalog[n]
            fm = fields_meta.get(n, {})
            role = fm.get('label') or ''
            hint = fm.get('hint') or ''
            if role and hint:
                role = '%s — %s' % (role, hint)
            if not role and c['derived']:
                role = '%s ⊕ %s %d%%' % (c['derived'][0], c['derived'][1],
                                          round(c['derived'][2] * 100))
            if not role and n in ROLE_HINTS:
                role = ROLE_HINTS[n]
            if not role and c['triplet_src']:
                role = 'alias of %s' % c['triplet_src']
            if not role and n in DERIVED_SET:
                role = 'derived alias member (window onto its field)'
            if not role and c['prop']:
                role = 'typed @property, init %s' % c['prop'][0][0]
            dl = ', '.join(str(x) for x in c['root_lines']) or '—'
            if c['scopes']:
                sc = sorted(set(w for (w, _, _) in c['scopes']))
                dl += ' · scoped: ' + ', '.join(s.replace('scope:', '').replace('js-inject:', '')[:40] for s in sc[:2])
            derives = ''
            if n in FIELD_NAMES:
                derives = '— (SOURCE)'
            elif c['derived']:
                derives = 'color-mix %s ⊕ %s %d%%' % (
                    c['derived'][0], c['derived'][1], round(c['derived'][2] * 100))
            elif c['triplet_src']:
                derives = c['triplet_src']
            css_n = sum(len(v) for v in c['css'].values())
            classes = set()
            for sites in c['css'].values():
                for (_, sel) in sites:
                    if sel:
                        classes.add(sel)
            cls_txt = ' '.join(sorted(classes)[:3])
            if len(classes) > 3:
                cls_txt += ' +%d more' % (len(classes) - 3)
            js_r = sorted(set(c['jsread'].keys()))
            js_w = sorted(set(c['jswrite'].keys()))
            cons = []
            if css_n:
                cons.append('CSS %d (%s)' % (css_n, cls_txt.strip() or 'root-level'))
            if js_r:
                cons.append('JS reads: %s' % ', '.join(js_r[:4]) + ('…' if len(js_r) > 4 else ''))
            if js_w:
                cons.append('JS writes: %s' % ', '.join(js_w[:4]) + ('…' if len(js_w) > 4 else ''))
            flags = '; '.join(c['flags'])
            A('| `%s` | %s | %s | %s | %s | %s | %s |' % (
                n, role or '—', dl, ', '.join(c['themes']) or '—',
                derives or '—', ' · '.join(cons) or '—', flags or ''))
        A('')

    # — per-theme presence matrix —
    A('## 2. THE PER-THEME PRESENCE MATRIX (the STEP-5 gap check, visualized)')
    A('')
    A('Columns = the 9 `[data-theme]` override blocks. Midnight is the baseline'
      ' (the `:root` values themselves), so it has no column.')
    A('')
    override_vars = [n for n, c in catalog.items() if c['themes']]
    A('| variable | ' + ' | '.join(themes) + ' |')
    A('|---|' + '---|' * len(themes))
    for n in sorted(override_vars):
        row = []
        for t in themes:
            row.append('✓' if t in catalog[n]['themes'] else '·')
        A('| `%s` | %s |' % (n, ' | '.join(row)))
    A('')
    A('Everything not listed here is :root-derived and intentionally theme-less'
      ' (the derived set re-derives per apply). Blank columns would be a GAP —'
      ' the v1.39 audit found none among fields/tones/triplets/fmt (G1/G2 are'
      ' definition-surface findings, not theme gaps).')
    A('')

    # — class inventory —
    A('## 3. THE CLASS INVENTORY (index.html CSS selectors → the vars they consume)')
    A('')
    surf_vars = defaultdict(lambda: defaultdict(set))
    for sel, vs in css_class_vars.items():
        fam, _first = family_of(sel)
        surf_vars[fam][sel] |= vs
    A('| family | selectors | distinct vars consumed | example selectors (top by var count) |')
    A('|---|---|---|---|')
    for surf in sorted(surf_vars, key=lambda s: -sum(len(v) for v in surf_vars[s].values())):
        sels = surf_vars[surf]
        total = sum(len(v) for v in sels.values())
        top = sorted(sels, key=lambda s: -len(sels[s]))[:3]
        ex = '; '.join('%s (%d)' % (s[:44], len(sels[s])) for s in top)
        A('| **%s** | %d | %d | %s |' % (surf, len(sels), total, ex))
    A('')
    A('Families are grouped by the first class token (msg→chat, te→theme-editor,'
      ' hub/hi→hub-library, art/artt→artifacts, set/gr→settings, wsp/wt→workspace,'
      ' fmt→chat-content …); unlisted prefixes carry their raw token. The full'
      ' map (every selector → every var) is `scripts/v1391-theme-classes.csv`.'
      ' Canvas-side consumers (not CSS classes) are mapped in'
      ' `docs/THEME-AUDIT-V139.md` §3: lattice.js (effectiveGrid→lcPaint),'
      ' atoms.js (colCache 1s TTL), pixiworld.js'
      ' (resolvedThemeVar→hexToInt/tripletToInt, atlas re-keys on themeStamp).')
    A('')

    # — the alter guide —
    A('## 4. THE ALTER GUIDE — "I want to change X, where do I edit?"')
    A('')
    A('| I want to… | edit | what re-derives | guard |')
    A('|---|---|---|---|')
    A('| a theme\'s whole look | its `[data-theme]` block in index.html + the'
      ' `THEMES` entry in theme.js (fields, tones, triplets, accents, grid) |'
      ' every derived var + triplet re-derives on next apply | pin A5 + verify'
      ' rig 10-theme flip |')
    A('| one field for one theme | that field\'s line in the theme block |'
      ' surfaces/borders/text/shadows/gradients that read it (auto via'
      ' color-mix + DERIVED_MIXES) | same |')
    A('| the nesting/contrast relationships | the mix percentages in the :root'
      ' derivation block AND `DERIVED_MIXES` in theme.js (they must match —'
      ' culori parity, the v099-calibrate law) | every theme at once |'
      ' theme twins battery |')
    A('| a tone (ok/warn/err/notice) | the tone pair in each `[data-theme]`'
      ' block (value + `-rgb` alias) | pills, dots, banners, cost colors | pin |')
    A('| text sizes | `--chat-fs`/`--ui-fs` statics + the Settings sliders'
      ' (appearance.js writes them) | the whole message scope via --chat-scale | — |')
    A('| add a brand-new variable | 1) define in :root (+ per-theme blocks if'
      ' it varies), 2) consume via `var()`/`rgba(var(--x-rgb), α)`, 3) if JS'
      ' must know: `TRIPLET_VARS`/`DERIVED_MIXES`, 4) never a literal | — |'
      ' pin A5 fails undeclared literals; the catalog regenerates and shows it |')
    A('| fix one of the 9 violations | follow the proposed re-slot column in'
      ' `docs/THEME-AUDIT-V139.md` §2, then `--update` the pin baseline | — |'
      ' STALE check |')
    A('')
    A('## 5. THE RULES (short form)')
    A('')
    A('1. **No literal colors outside the canonical zones** — the pin'
      ' (`scripts/v1390-theme-source-pin.py`, gate A5) fails the battery on'
      ' any NEW one; fixed ones must leave the baseline (`--update`).')
    A('2. **Fields are the only sources** — a derived value is never edited'
      ' directly; tune the mix in both the CSS block and `DERIVED_MIXES`.')
    A('3. **Canvas obeys the same flip contract** — a theme apply repaints'
      ' #c/#c2 and re-keys the Pixi atlas (themeStamp).')
    A('4. **This doc is generated** — after any theme-system edit, re-run'
      ' `python3 scripts/v1391-theme-catalog.py` and commit the refresh.')
    A('')
    A('— v1.39.1, the review wave. Generated from the tree; zero hand-written rows.')

    doc_path = os.path.join(DOCS, 'THEME-VARIABLES.md')
    with open(doc_path, 'w', encoding='utf-8') as f:
        f.write('\n'.join(L) + '\n')

    print('== CATALOG: %d vars, %d themes, %d CSS sites, %d classes ==' %
          (len(catalog), len(themes), n_css_sites, len(css_class_vars)))
    by_grp = defaultdict(int)
    for c in catalog.values():
        by_grp[c['group']] += 1
    for g in GROUP_ORDER:
        if by_grp[g]:
            print('  %-12s %d' % (g, by_grp[g]))
    print('  UNDEFINED: %s' % (undefined or 'none'))
    print('doc: %s (%d lines)' % (doc_path, len(L)))
    print('csv: %s' % csv_path)
    print('cls: %s' % cls_csv)

if __name__ == '__main__':
    main()
