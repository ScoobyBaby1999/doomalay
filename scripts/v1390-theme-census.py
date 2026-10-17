#!/usr/bin/env python3
# v1390-theme-census.py — THE THEME CENSUS (v1.39.0, the THEME AUDIT wave).
#
# GOAL (the user's directive): "a complete element→theme-variable inventory
# + violation report" over the embedded web tree — and the source-pin
# baseline for the house rig (any NEW literal color outside the canonical
# zones must fail the audit).
#
# WHAT IT DOES
#   1. Tokenizes every web/ JS/HTML/JSON file (vendor excluded), stripping
#      comments so doc mentions never count.
#   2. Extracts every color-ish token: #hex{3,4,6,8}, rgb/rgba(), hsl/hsla().
#   3. Classifies each occurrence into a zone (docs/DISCIPLINE.md's table):
#        var-composition     rgba(var(--x-rgb), a)            — sanctioned
#        dynamic-composition rgba(<runtime triplet>, a)       — sanctioned
#        theme-def / engine / picker / fmt / brand / ink-on-art /
#        crop / glow / mask-shape / transparent-end / zero-point /
#        svg-ref / id-selector / not-a-color
#        VIOLATION           none of the above                — must be fixed
#                                                             or allowlisted
#   4. Emits: (a) the full inventory CSV, (b) the violation table (markdown),
#      (c) the per-theme variable-set diff (the fallback-gap report),
#      (d) the source-pin baseline JSON (scripts/v1390-theme-pin-baseline.json).
#
# The PIN (v1390-theme-source-pin.py) re-runs steps 1–3 and diffs against
# the baseline: any NEW literal outside the canonical zones fails; any STALE
# baseline entry fails too (the RUF100 law — the ledger must stay honest).

import json
import os
import re
import sys
from collections import defaultdict

WEB = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                   '..', 'engine', 'internal', 'server', 'web')

# ── file universe ────────────────────────────────────────────────────
SKIP_DIRS = ('vendor',)
THEME_DEF_FILES = {'theme.js', 'formatter.js'}          # the JS engine + fmt
# index.html is handled per-line (the :root/[data-theme] blocks are the
# system itself; the rest of the file classifies like any consumer).

HEX_RE = re.compile(r'#[0-9a-fA-F]{3,8}\b')
RGBA_RE = re.compile(r'\brgba?\(\s*[^)]*\)')
HSLA_RE = re.compile(r'\bhsla?\(\s*[^)]*\)')

# zone allowlist per file (docs/DISCIPLINE.md "Canonical zones"); keys are
# repo-relative paths under web/
FILE_ZONES = {
    'theme.js':      'engine',
    'formatter.js':  'fmt',
    'themeeditor.js':'picker',
    'uikit.js':      'gradient-engine',   # renders USER spec colors — data, not chrome
}
# provider/family brand hexes — identity data, not theme chrome
BRAND_FILES = {'chatsview.js', os.path.join('config', 'families.json')}
# line-range canonical zones (documented in DISCIPLINE.md; the audit
# cross-checks these markers still exist so the ranges can't rot)
RANGE_ZONES = [
    # app.js DEFAULT_FAMILIES — brand identity data
    ('app.js', 34, 44, 'brand', 'DEFAULT_FAMILIES'),
    # hub.js flagStyle — ink-on-art: the WCAG contrast pick against USER art
    ('hub.js', 1908, 1964, 'ink-on-art', 'flagStyle art-ink'),
    # hub.js idColors/idGradient — GENERATED art (hash-of-id palette), the
    # "hub item art" canonical zone; not chrome
    ('hub.js', 160, 200, 'ink-on-art', 'idColors'),
    # formatter.js popYTOut — the PiP theater: a separate window with NO
    # theme DOM; the black is the video surface (like the crop surround)
    ('formatter.js', 797, 810, 'media-black', 'popYTOut PiP theater'),
    # index.html .te-* — the theme EDITOR's HSV wheel (the picker IS the
    # color space: the conic hue disc, the white core, the V-ramp)
    ('index.html', 1890, 1980, 'picker', 'te-wheel-disc'),
    # index.html .crop-frame — the crop frame's white edge + dark surround
    # (contrast over arbitrary USER images — documented)
    ('index.html', 5158, 5168, 'crop', '.crop-frame'),
    # index.html .fmt-yt-* — the YouTube embed surfaces: the player
    # letterbox black + the .fmt-yt-play brand red (documented)
    ('index.html', 2752, 2870, 'media-black', 'fmt-yt-thumb'),
    # uikit.js _selftest — the GradientUI pure-function assertions: the
    # oracle hexes are TEST DATA, never chrome (test_uikit.js runs them)
    ('uikit.js', 978, 1172, 'self-test', '_selftest'),
    # uikit.js:174 — the node-harness catch twin (v1040 gate C2 pins it)
    ('uikit.js', 174, 174, 'harness-twin', 'pinned by'),
    # atoms.js starPath PROBE — the arc-vs-baked-path benchmark paints a
    # throwaway offscreen canvas; the fillStyle is measurement plumbing
    ('atoms.js', 320, 355, 'probe-paint', 'starPath'),
    # appearance.js — the veil-ink editor's zero defaults (= the :root
    # --veil-ink #000000; the documented zero-point zone)
    ('appearance.js', 872, 872, 'zero-point', 'veil zero'),
    ('appearance.js', 961, 961, 'zero-point', 'veil zero'),
    # lattice.js rgbaStr — the pure hex→rgba converter (callers pass
    # theme-resolved hexes; the numbers here are bit-shift plumbing)
    ('lattice.js', 196, 200, 'converter', 'function rgbaStr'),
]
# marker the range check requires on or near the range (anti-rot pin)
RANGE_MARKERS = {
    'DEFAULT_FAMILIES': 'DEFAULT_FAMILIES',
    'flagStyle art-ink': 'ink-on-art is FUNCTIONAL',
    'idColors': 'idColors',
    'popYTOut PiP theater': 'documentPictureInPicture',
    'te-wheel-disc': '.te-wheel-disc',
    '.crop-frame': '.crop-frame',
    'fmt-yt-thumb': '.fmt-yt-thumb',
    '_selftest': '_selftest',
    'pinned by': 'pinned by',
    'starPath': 'starPath',
    'veil zero': "opts.spec || { colors: ['#000000']",
    'function rgbaStr': 'function rgbaStr',
}

SEL_CTX_RE = re.compile(
    r"(querySelector(?:All)?|getElementById|closest|matches|WebKitCSSMatrix"
    r"|\$\()\s*['\"]$")
VARFALLBACK_RE = re.compile(r"var\(--[a-z0-9-]+,\s*$", re.I)
URL_REF_RE = re.compile(r"url\(\s*['\"]?#", re.I)

# provenance markers: a 'rgba(' + x +'…' is SANCTIONED when the runtime
# value it interpolates resolves from the theme system (a triplet var,
# the atoms cache, a DoomTheme read, or a parameter fed from one).
DYNAMIC_TRACE_RE = re.compile(
    r"var\(--[a-z0-9-]+-rgb\)|-rgb\b|triplet\(|colorsFor|themeColors|"
    r"resolvedThemeVar|effectiveGrid|Theme\.FALLBACKS|hexTriplet|"
    r"avgStops|mixHex|onColorFor|artL|relLum|hexToRgb|quantColor|"
    r"shadeHex|hexRGB|headCol|colors\(\)|colCache")

def trace_dynamic(code_line, code_lines, lineno):
    """Look ±60 lines around a dynamic rgba(' + x + ') composition for
    theme provenance; accept when found, else keep for review."""
    lo = max(0, lineno - 61)
    hi = min(len(code_lines), lineno + 60)
    window = '\n'.join(code_lines[lo:hi])
    if DYNAMIC_TRACE_RE.search(code_line) or DYNAMIC_TRACE_RE.search(window):
        return 'dynamic-var-composition'
    return 'dynamic-review'

def strip_comments(text, path):
    """Remove /* */ (multi-line, state machine) and // comments,
    string-quote aware enough for our code (no comment-like text inside
    strings that matters for classification — url(#…) survives)."""
    out_lines = []
    in_block = False
    in_body = False          # inside a <style>/<script> body? not needed
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
                    res.append(line[i+1]); i += 2; continue
                if c == quote:
                    quote = None
                i += 1
                continue
            if c in ('\'', '"', '`'):
                quote = c; res.append(c); i += 1; continue
            if line.startswith('/*', i):
                in_block = True; i += 2; continue
            if line.startswith('//', i):
                break          # rest of the line is comment
            res.append(c); i += 1
        out_lines.append(''.join(res))
        # NOTE: an unterminated /* at EOL keeps in_block True for next lines
    return '\n'.join(out_lines)

def classify_hex(path, lineno, raw_line, code_line, tok, col):
    """Classify one #hex token occurrence."""
    # not-a-color contexts first
    pre = code_line[max(0, col-24):col]
    if URL_REF_RE.search(pre + code_line[col:col+2]):
        return 'svg-ref'
    if SEL_CTX_RE.search(pre):
        return 'id-selector'
    # selector-ish continuation (#c, #panel — a color never has these after)
    rest = code_line[col+len(tok):col+len(tok)+2]
    if re.match(r"[\s.\[:,>~)]", rest) and not re.match(r"[,;'\"]", rest):
        # '#c)' / '#panel,' → selector; but '#fff,' could be a palette...
        if len(tok) <= 9 and not re.fullmatch(r'#[0-9a-fA-F]{3,4}|#[0-9a-fA-F]{6}|#[0-9a-fA-F]{8}', tok):
            return 'id-selector'
    low = tok.lower()
    # mask/gradient SHAPE contexts first (content-based, zone-independent):
    # #000 in a mask cutout is an alpha shape, not a painted color
    if low in ('#000', '#0000', '#000000', '#00000000'):
        if 'mask' in code_line.lower() or 'linear-gradient(#000 0 0)' in code_line:
            return 'mask-shape'
    # var-fallback: var(--x, #fff) — the theme always defines --x; the
    # literal is a dead in-var fallback (noted, not chrome)
    if VARFALLBACK_RE.search(code_line[max(0, col-40):col]):
        return 'var-fallback'
    # color-mix endpoints: #000/#fff as the DERIVATION INPUT beside a var
    # (the --shadow-ink shape: color-mix(in oklab, var(--field-canvas), #000 55%))
    if 'color-mix(' in code_line and low in ('#000', '#000000', '#fff', '#ffffff'):
        return 'mix-endpoint'
    # file zones own their constants (theme.js's veil picks, the picker's
    # #fff handle, the fmt schemes) — BEFORE the white/black shortcuts
    base = os.path.basename(path)
    relp = os.path.relpath(path, WEB)
    z = FILE_ZONES.get(base)
    if z:
        return z
    if relp in BRAND_FILES:
        return 'brand'
    if base == 'index.html':
        return 'index-html'          # per-line zone check happens later
    # transparent ends
    if low in ('#000', '#0000', '#000000', '#00000000'):
        return 'zero-black'
    if low in ('#fff', '#ffffff', '#ffffffff'):
        return 'white-constant'
    return 'VIOLATION-candidate'

def classify_func(path, lineno, raw_line, code_line, tok):
    """Classify one rgb/rgba/hsl/hsla literal."""
    base = os.path.basename(path)
    inner = tok[tok.index('(')+1:tok.rindex(')')]
    args = [a.strip() for a in inner.split(',')]
    head = args[0] if args else ''
    # var-composition: rgba(var(--x), a) / rgba(var(--x-rgb), a)
    if 'var(--' in inner:
        return 'var-composition'
    # parameterized var-composition: rgba(var(' + rgbVar + '), …) — the
    # var( is inside the token, the var NAME rides the concat
    if "var(' +" in tok or "var(\" +" in tok:
        return 'dynamic-var-composition'
    # dynamic-composition: rgba(' + rgb + ', …) — the triplet is a runtime
    # var read (chatpanel/persona/workspace shapes); the concatenation shows
    # as string-breaks inside the token: rgba( + rgb + ,0.16)
    if ("'" in tok or '"' in tok) and "var(" not in tok:
        # an indexOf('rgba(') style string-search argument is not a color
        head2 = inner.strip()
        if head2.startswith(("'", '"')) or head2.endswith(("'", '"')):
            return 'not-a-color'
        # lookbehind on the line: does the string concat carry a triplet var?
        if re.search(r"-rgb\b|triplet|\.rgb\b|m\.rgb|Tri\b", code_line):
            return 'dynamic-var-composition'
        return 'dynamic-review'
    # numeric hsl() art builders (hub art palettes)
    if tok.startswith('hsl') and re.fullmatch(r"[\d\s,.%-]+", inner or ''):
        if base == 'hub.js':
            return 'ink-on-art'
        return 'hsl-literal'
    if not inner.strip():
        return 'not-a-color'      # rgba() inside a substring test / doc ref
    if head.strip().startswith(("'", '"')):
        return 'not-a-color'      # indexOf('rgba(') — a string search arg
    if not re.fullmatch(r"[\d\s,.%]+", head or ''):
        return 'dynamic-review'
    nums = [a for a in args if re.fullmatch(r"[\d.]+%?", a)]
    if len(nums) < 3:
        return 'dynamic-review'
    # fully transparent ends — transparency, not a color
    alpha = None
    if len(args) >= 4:
        am = re.fullmatch(r"([\d.]+)%?", args[3])
        if am:
            alpha = float(am.group(1)) / 100.0 if args[3].endswith('%') else float(am.group(1))
    if alpha == 0:
        return 'transparent-end'
    rgbv = []
    for a in args[:3]:
        am = re.fullmatch(r"([\d.]+)%?", a)
        rgbv.append(float(am.group(1)) / 100 * 255 if (am and a.endswith('%')) else (float(am.group(1)) if am else -1))
    # gradient/data-pipeline engines own their runtime-color plumbing
    # (uikit's rgba() helper works on USER spec colors — never chrome)
    base = os.path.basename(path)
    relp = os.path.relpath(path, WEB)
    z = FILE_ZONES.get(base)
    if z:
        return z
    if relp in BRAND_FILES:
        return 'brand'
    is_white = all(abs(v - 255) < 1 for v in rgbv)
    is_black = all(abs(v) < 1 for v in rgbv)
    if is_white:
        return 'white-constant'      # crop frame / glow / highlight precedents
    if is_black:
        return 'zero-black'          # shadow-ink era survivors / zero-points
    if base == 'hub.js':
        return 'ink-on-art'
    return 'VIOLATION-candidate'

def index_html_zone(raw_line, in_theme_block):
    """The theme-def zone = the :root/[data-theme]/@property blocks."""
    return 'theme-def' if in_theme_block else None

def track_blocks(text):
    """Return the set of line numbers inside :root/[data-theme]/@property
    blocks of index.html (brace-tracked, comments ignored)."""
    inside = set()
    depth = 0
    block_open = False
    for lineno, line in enumerate(text.split('\n'), 1):
        code = line
        m = re.search(r'/(\*)|//', code)
        # crude but adequate: strip same-line comments for detection
        code = re.sub(r'/\*.*?\*/', '', code)
        code = re.sub(r'//.*$', '', code)
        opens = code.count('{')
        closes = code.count('}')
        if not block_open and re.search(r'(:root\s*\{|\[data-theme[^\]]*\]\s*\{|@property[^\{]*\{)', code):
            block_open = True
            inside.add(lineno)
            depth = opens - closes
            if depth <= 0 and closes > 0:
                block_open = False
            continue
        if block_open:
            inside.add(lineno)
            depth += opens - closes
            if depth <= 0:
                block_open = False
    return inside

def main():
    rows = []          # (file, lineno, kind, token, zone, excerpt)
    files = []
    for root, dirs, names in os.walk(WEB):
        rel = os.path.relpath(root, WEB)
        if any(rel == d or rel.startswith(d + os.sep) for d in SKIP_DIRS):
            continue
        for n in names:
            if n.endswith(('.js', '.html', '.json', '.css')):
                files.append(os.path.join(root, n))
    ix_blocks = track_blocks(open(os.path.join(WEB, 'index.html'),
                                  encoding='utf-8', errors='replace').read())
    for path in sorted(files):
        relp = os.path.relpath(path, WEB)
        with open(path, encoding='utf-8', errors='replace') as f:
            text = f.read()
        code_lines = strip_comments(text, path).split('\n')
        raw_lines = text.split('\n')
        # the CANON markers (v1040 convention): a raw line carrying
        # CANON-TWIN / CANON: / FALLBACKS is a documented literal owner
        canon_lines = set()
        for lineno, rl in enumerate(raw_lines, 1):
            if re.search(r'CANON-TWIN|CANON:|DoomTheme\.FALLBACKS', rl):
                canon_lines.add(lineno)
        def apply_overrides(zone, relp, lineno, raw):
            # canon markers first (the anti-rot pin cross-checks them)
            if lineno in canon_lines:
                return 'canon-marker'
            # index.html white/black/mix INSIDE the theme blocks = the
            # system's own constants (--on-accent, --veil-ink, --shadow-ink)
            if (relp == 'index.html' and lineno in ix_blocks and
                    zone in ('white-constant', 'zero-black', 'mix-endpoint')):
                return 'theme-def'
            for (rf, a, b, rz, label) in RANGE_ZONES:
                if relp == rf and a <= lineno <= b:
                    return rz
            return zone
        OVR_ZONES = ('VIOLATION-candidate', 'zero-black', 'white-constant',
                     'index-html-consumer', 'mix-endpoint', 'dynamic-review',
                     'hsl-literal')
        for lineno, (rl, cl) in enumerate(zip(raw_lines, code_lines), 1):
            for m in HEX_RE.finditer(cl):
                tok = m.group(0)
                zone = classify_hex(path, lineno, rl, cl, tok, m.start())
                if zone == 'index-html':
                    z2 = index_html_zone(rl, lineno in ix_blocks)
                    zone = z2 or 'index-html-consumer'
                if zone in OVR_ZONES:
                    zone = apply_overrides(zone, relp, lineno, rl)
                rows.append((relp, lineno, 'hex', tok, zone, rl.strip()[:160]))
            for m in RGBA_RE.finditer(cl):
                tok = m.group(0)
                zone = classify_func(path, lineno, rl, cl, tok)
                if zone == 'dynamic-review':
                    zone = trace_dynamic(cl, code_lines, lineno)
                if zone in OVR_ZONES:
                    zone = apply_overrides(zone, relp, lineno, rl)
                if relp == 'uikit.js' and zone == 'dynamic-review':
                    zone = 'gradient-engine'   # engine internals on user data
                rows.append((relp, lineno, 'rgb', tok, zone, rl.strip()[:160]))
            for m in HSLA_RE.finditer(cl):
                tok = m.group(0)
                zone = classify_func(path, lineno, rl, cl, tok)
                if zone == 'dynamic-review':
                    zone = trace_dynamic(cl, code_lines, lineno)
                if zone in OVR_ZONES:
                    zone = apply_overrides(zone, relp, lineno, rl)
                rows.append((relp, lineno, 'hsl', tok, zone, rl.strip()[:160]))

    # ── the buckets ──
    ok_zones = {'var-composition', 'dynamic-var-composition', 'svg-ref',
                'id-selector', 'transparent-end', 'mask-shape',
                'engine', 'fmt', 'picker', 'brand', 'ink-on-art',
                'theme-def'}
    review = [r for r in rows if r[4] in ('VIOLATION-candidate', 'dynamic-review',
                                          'zero-black', 'white-constant',
                                          'hsl-literal', 'index-html-consumer')]
    violations = [r for r in rows if r[4] == 'VIOLATION-candidate']

    # ── outputs ──
    out_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)))
    csv_path = os.path.join(out_dir, 'v1390-theme-census.csv')
    with open(csv_path, 'w', encoding='utf-8') as f:
        f.write('file,line,kind,token,zone,excerpt\n')
        for r in rows:
            f.write('%s,%d,%s,"%s",%s,"%s"\n' % (
                r[0], r[1], r[2], r[3].replace('"', '""'), r[4],
                r[5].replace('"', '""')))
    print('== CENSUS: %d occurrences across %d files == (%s)' %
          (len(rows), len(files), csv_path))
    by_zone = defaultdict(int)
    for r in rows:
        by_zone[r[4]] += 1
    for z, c in sorted(by_zone.items(), key=lambda kv: -kv[1]):
        print('  %-26s %d' % (z, c))
    print()
    print('== NEEDS EYES (%d) ==' % len(review))
    seen = set()
    for r in review:
        key = (r[0], r[4], r[3])
        print('  %-9s %-22s %-22s %s' % (r[4], r[0]+':'+str(r[1]), r[3], r[5][:110]))
    return rows, ok_zones

if __name__ == '__main__':
    main()
