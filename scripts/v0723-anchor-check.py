#!/usr/bin/env python3
"""v0723 C4 anchor check — reads /tmp/v0723-anchor.json
({pos: '<computed background-position>', top: N}).

v0.74 rebase: the tab is a 3-layer window (projection + plate + ring),
and the painter's anchors are calc(var(--proj-tx) ± Bpx) — the COMPUTED
position resolves to per-layer used values like
'-101.4px -376.8px, -101.4px -376.8px, -101.4px -376.8px'. Every layer
shares the same offset, so parse ALL px numbers and take the first Y;
it must track -top (the painter re-anchored the window to the element's
NEW viewport position)."""
import json
import re

try:
    half = json.load(open('/tmp/v0723-anchor.json'))
    nums = [float(x) for x in re.findall(r'-?\d+\.?\d*', half['pos'])]
    # first pair = (x, y) of layer 1; tolerate a leading '-' split
    if len(nums) < 2:
        raise ValueError('no px pair in %r' % half['pos'])
    got = nums[1]
    want = -half['top']
    print('OK' if abs(got - want) < 4 else 'STALE(got=%.1f want=%.1f)' % (got, want))
except Exception as e:
    print('PARSE-FAIL: %s' % e)
