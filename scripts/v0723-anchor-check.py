#!/usr/bin/env python3
"""v0723 C4 anchor check — reads /tmp/v0723-anchor.json
({pos: '-x -y px', top: N}); the pos Y must track -top (the painter
re-anchored the window to the element's NEW viewport position)."""
import json

try:
    half = json.load(open('/tmp/v0723-anchor.json'))
    pos = half['pos'].split()
    want = -half['top']
    got = float(pos[1].replace('px', ''))
    print('OK' if abs(got - want) < 4 else 'STALE(got=%.1f want=%.1f)' % (got, want))
except Exception as e:
    print('PARSE-FAIL: %s' % e)
