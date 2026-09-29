#!/usr/bin/env python3
"""v0723 pixel sampler — reads /tmp/v0723-probe.png + /tmp/v0723-info.json,
samples each pill's top/middle/bottom pixel, prints the verdict."""
import json, subprocess, sys

try:
    from PIL import Image
except ImportError:
    subprocess.run([sys.executable, '-m', 'pip', 'install', '-q', 'pillow'], check=True)
    from PIL import Image

img = Image.open('/tmp/v0723-probe.png').convert('RGB')
info = json.load(open('/tmp/v0723-info.json'))
out = []
for p in info['pills']:
    if p['w'] < 40 or p['h'] < 12:
        continue
    x = p['x'] + p['w'] // 2
    ys = [p['y'] + 2, p['y'] + p['h'] // 2, p['y'] + p['h'] - 3]
    row = []
    for y in ys:
        if 0 <= y < img.height and 0 <= x < img.width:
            row.append('#%02x%02x%02x' % img.getpixel((x, y)))
    if row:
        out.append({'cls': p['cls'], 'y': p['y'], 'h': p['h'], 'colors': row})
print(json.dumps(out))
