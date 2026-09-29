#!/usr/bin/env python3
"""v0723 verdict — reads /tmp/v0723-samples.json, decides PROJECTION/TILING."""
import json, sys

samples = json.load(open('/tmp/v0723-samples.json'))
if len(samples) < 2:
    print(json.dumps({'verdict': 'insufficient', 'n': len(samples)}))
    sys.exit(0)

def warmth(hexcol):
    r = int(hexcol[1:3], 16)
    b = int(hexcol[5:7], 16)
    return r - b  # red-dominant = warm (the top of the field)

s_hi = min(samples, key=lambda s: s['y'])
s_lo = max(samples, key=lambda s: s['y'])
hi_top = warmth(s_hi['colors'][0])
lo_top = warmth(s_lo['colors'][0])
hi_span = abs(warmth(s_hi['colors'][0]) - warmth(s_hi['colors'][-1]))
lo_span = abs(warmth(s_lo['colors'][0]) - warmth(s_lo['colors'][-1]))
# PROJECTION: the higher pill's top reads warmer than the lower pill's
# top (they sample different regions), and each pill's INTERNAL span is
# small (a thin slice of the field).
# TILING: both pills sweep the whole palette internally (big spans) and
# their tops match (both ≈ the gradient's first stop).
projection = (hi_top - lo_top) > 60 and hi_span < 120 and lo_span < 120
tiling = hi_span > 150 and lo_span > 150 and abs(hi_top - lo_top) < 80
verdict = 'PROJECTION' if projection else ('TILING' if tiling else 'MIXED')
print(json.dumps({'verdict': verdict, 'hiTop': hi_top, 'loTop': lo_top,
                  'hiSpan': hi_span, 'loSpan': lo_span,
                  'hiCls': s_hi['cls'], 'loCls': s_lo['cls']}))
