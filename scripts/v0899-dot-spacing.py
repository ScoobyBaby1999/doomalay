#!/usr/bin/env python3
"""v0899-dot-spacing.py — THE PIXEL ASPECT PROOF for the stretch fix.

Reads a screenshot of the lattice, finds the bright dot components, and
measures the nearest-neighbor pitch along X vs along Y. A square lattice
(48px cells at scale 1) must show dy/dx ≈ 1.0. The pre-fix bug (bitmap
stuck at 300×150, CSS-stretched to the window) showed dy/dx ≈ 4.3 at the
400×850 rig geometry — dots as tall streaks, the user's "stretched
ridiculously / nauseating".

Exit: prints a JSON verdict line; code 0 = round (pass), 1 = stretched.
"""
import sys, json
import numpy as np
from PIL import Image

def main():
    path = sys.argv[1]
    # margins to exclude: chrome (top status, bottom dock) + the seeded
    # icon's box (icon at world 300,250 → screen 300,250 at scale 1)
    TOP, BOTTOM, SIDE = 60, 160, 16
    img = np.asarray(Image.open(path).convert('L'), dtype=np.uint8)
    H, W = img.shape
    mask = img > 90
    mask[:TOP, :] = False
    mask[H - BOTTOM:, :] = False
    mask[:, :SIDE] = False
    mask[:, W - SIDE:] = False
    # the icon's exclusion box (generous)
    mask[170:340, 210:400] = False

    # connected components (4-neighbor flood fill, dots are 2-8px blobs)
    visited = np.zeros_like(mask, dtype=bool)
    cents = []
    ys, xs = np.where(mask)
    for y0, x0 in zip(ys, xs):
        if visited[y0, x0]:
            continue
        stack = [(y0, x0)]
        visited[y0, x0] = True
        n = 0; sy = 0; sx = 0
        while stack:
            y, x = stack.pop()
            n += 1; sy += y; sx += x
            for dy, dx in ((1,0),(-1,0),(0,1),(0,-1)):
                ny, nx = y + dy, x + dx
                if 0 <= ny < H and 0 <= nx < W and mask[ny, nx] and not visited[ny, nx]:
                    visited[ny, nx] = True
                    stack.append((ny, nx))
        if 2 <= n <= 400:          # a dot (skip hairline specks / big UI)
            cents.append((sx / n, sy / n))
    if len(cents) < 12:
        print(json.dumps({"ok": False, "why": "too few dots", "dots": len(cents)}))
        return 1

    pts = np.array(cents)
    xs2 = pts[:, 0]; ys2 = pts[:, 1]
    dxs, dys = [], []
    for i in range(len(pts)):
        d = np.abs(pts - pts[i])
        # same-row neighbor: |dy| < 14 → the x pitch
        row = (d[:, 1] < 14) & (d[:, 0] > 1)
        if row.any():
            dxs.append(float(np.min(d[row, 0])))
        # same-column neighbor: |dx| < 14 → the y pitch
        col = (d[:, 0] < 14) & (d[:, 1] > 1)
        if col.any():
            dys.append(float(np.min(d[col, 1])))
    if len(dxs) < 6 or len(dys) < 6:
        print(json.dumps({"ok": False, "why": "sparse", "dxs": len(dxs), "dys": len(dys)}))
        return 1
    mdx = float(np.median(dxs)); mdy = float(np.median(dys))
    ratio = mdy / mdx if mdx > 0 else 99.0
    ok = 0.6 <= ratio <= 1.55
    print(json.dumps({"ok": ok, "dots": len(cents), "pitch_x": round(mdx, 1),
                      "pitch_y": round(mdy, 1), "ratio": round(ratio, 2)}))
    return 0 if ok else 1

if __name__ == '__main__':
    sys.exit(main())
