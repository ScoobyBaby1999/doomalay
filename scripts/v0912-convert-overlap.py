#!/usr/bin/env python3
"""v0912-convert-overlap.py — convert the small-chrome plain var(--surface-2)
fills that OVERLAP the v0.91.2 native Layer-3 list to --raised-chrome, so
the gradient-twin path (the [data-s2-grad] window, !important background-
image + fixed) cannot re-project small controls either.

Medium cards (.hmsg-card, .hub-card:active, .hub-bunch-hero), the chatbot
disc, the link viewer (.lv-*), .fmt-code-inline, the [style*=] catchers and
the :hover/:active-only states stay on the projected window (the intended
gradient-following look where the field is visible or the machinery for
dynamic content).

Every conversion asserts exactly-one-replacement; a miss aborts loudly
(the v076 lesson: silent no-ops are forbidden).
"""
import io, re, sys

P = 'engine/internal/server/web/index.html'
s = io.open(P, encoding='utf-8').read()

# (anchor line content, unique context before/after) — matched as exact
# substrings; each must occur exactly once.
TARGETS = [
    # .err-switch
    ('.err-switch', 'background: var(--surface-2);'),
    # .starter-chip:hover / .chat-jump / .ts-chip
    ('.chat-jump', 'background: var(--surface-2);'),
    ('.ts-chip', 'background: var(--surface-2);'),
    # .art-rename-input / .art-sheet-btn / .art-sheet-input / .art-toast
    ('.art-rename-input', 'background: var(--surface-2);'),
    ('.art-sheet-btn', 'background: var(--surface-2);'),
    ('.art-sheet-input', 'background: var(--surface-2);'),
    ('.art-toast', 'background: var(--surface-2);'),
    # .pv-input/.pv-select / .pv-btn
    ('.pv-input, .pv-select', 'background: var(--surface-2);'),
    ('.pv-btn', 'background: var(--surface-2);'),
    # #chat-search-input / .chat-search-nav / #util-row .util-btn
    ('#chat-search-input', 'background: var(--surface-2);'),
    ('.chat-search-nav', 'background: var(--surface-2);'),
    ('#util-row .util-btn', 'background: var(--surface-2);'),
    # .hub-searchico / .hub-search / .hub-libpill / .hub-ctl
    ('.hub-searchico', 'background: var(--surface-2);'),
    ('.hub-search', 'background: var(--surface-2);'),
    ('.hub-libpill', 'background: var(--surface-2);'),
    ('.hub-ctl', 'background: var(--surface-2);'),
    # .hub-bunch-sec-n / .hub-bunch-chip / .hub-memq-x
    ('.hub-bunch-sec-n', 'background: var(--surface-2);'),
    ('.hub-bunch-chip', 'background: var(--surface-2);'),
    ('.hub-memq-x', 'background: var(--surface-2);'),
    # .hub-nav / .hp-icocell / .hi-viewseg / .hi-fab / .hi-delbar
    ('.hub-nav', 'background: var(--surface-2);'),
    ('.hp-icocell', 'background: var(--surface-2);'),
    ('.hi-viewseg', 'background: var(--surface-2);'),
    ('.hi-fab', 'background: var(--surface-2);'),
    ('.hi-delbar', 'background: var(--surface-2);'),
    # .hp-textarea / .hp-color / .hp-mini / .hp-pick / .hp-focus-btn
    ('.hp-textarea', 'background: var(--surface-2);'),
    ('.hp-color', 'background: var(--surface-2);'),
    ('.hp-mini', 'background: var(--surface-2);'),
    ('.hp-pick', 'background: var(--surface-2);'),
    ('.hp-focus-btn', 'background: var(--surface-2);'),
    # .dx-pill / .gr-color / .tw-iconcell
    ('.dx-pill', 'background: var(--surface-2);'),
    ('.gr-color', 'background: var(--surface-2);'),
    ('.tw-iconcell', 'background: var(--surface-2);'),
    # .hub-sortico:hover (a transient chip state)
    ('.hub-sortico:hover', 'background: var(--surface-2);'),
]

# find each rule block: "<selector-ish line> {" then the fill within the
# next few lines. We operate on the rule body: from the selector line to
# the closing '}'.
lines = s.split('\n')
def find_rule_block(sel_token):
    """return (start_idx, end_idx) of the rule whose selector line contains
    sel_token as a whole selector token (boundary-safe: '.hub-search' must
    not match '.hub-searchico')."""
    pat = re.compile(re.escape(sel_token) + r'([\s,{:]|$)')
    for i, ln in enumerate(lines):
        if not ln.strip().startswith('/*') and pat.search(ln):
            # confirm a '{' on this line or shortly after
            j = i
            while j < len(lines) and j <= i + 4:
                if '{' in lines[j]:
                    # find the closing brace
                    k = j
                    while k < len(lines) and '}' not in lines[k]:
                        k += 1
                    return (j, k)
                if '}' in lines[j]:
                    break
                j += 1
    return None

converted = 0
for sel, fill in TARGETS:
    blk = find_rule_block(sel)
    if blk is None:
        print('ABORT: rule not found for', sel); sys.exit(1)
    start, end = blk
    hit = None
    for i in range(start, end + 1):
        if fill in lines[i]:
            hit = i
            break
    if hit is None:
        print('ABORT: fill not found inside', sel); sys.exit(1)
    lines[hit] = lines[hit].replace(fill, 'background-color: var(--raised-chrome);')
    converted += 1

io.open(P, 'w', encoding='utf-8').write('\n'.join(lines))
print('converted', converted, 'rules')
