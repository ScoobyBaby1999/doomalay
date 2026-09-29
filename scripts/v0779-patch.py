#!/usr/bin/env python3
"""v0779-patch.py — the size-depth lattice rework (app.js).

Replaces v0.77.2's hardcoded 3-layer starfield (spawned FAR/MID/NEAR
orbs at fixed pan factors) with SIZE-DERIVED depth: the lattice's own
dots and line segments — whose sizes come from the user's size
variation + bias + scale settings — are partitioned into depth bands by
their size hash, and each band rides its own parallax factor (biggest =
closest, faster than the icons; smallest = furthest, nearly pinned).
amp 0 stays the byte-identical single-plane default.
"""
import re
import sys

P = 'engine/internal/server/web/app.js'
s = open(P, encoding='utf-8').read()
orig = s

# ── 1. the amplifier comment + starLayer → the depth-band machinery ──────
old_head = '''    // ── v0.75 THE AMPLIFIER (user spec: rename the slider, REPLACE the
    // method — the v0.67 differential lag "makes it worse not better
    // visually"; at 0 the default behavior is untouched) ──
    // v0.77 THE VISIBILITY REWORK (user spec: "not very noticeable, change
    // method again or make it more noticeable"): the v0.75 stack painted
    // sub-pixel stars (r ≈ 0.45px) and only slowed the backdrop 0.35→0.20
    // — real depth, beneath perception. The amplifier now builds a
    // THREE-LAYER stack with real contrast:
    //   · NEAR — a sparse foreground of big soft-glow orbs riding pan
    //     factor 1.6 (FASTER than the lattice: foreground parallax, the
    //     strongest depth cue; ~6-8 per viewport);
    //   · MID — medium stars at 0.5 (half the lattice's speed);
    //   · FAR — a dense field of small stars at 0.16 (nearly pinned);
    //   · the backdrop camera slows 0.35 → 0.08 at full amp.
    // The lattice itself stays ONE FLAT PLANE at pan factor 1 (amp 0 is
    // still the byte-identical default: zero stars, camera 0.35).'''
new_head = '''    // ── v0.75 THE AMPLIFIER (user spec: rename the slider, REPLACE the
    // method — the v0.67 differential lag "makes it worse not better
    // visually"; at 0 the default behavior is untouched) ──
    // v0.77.9 THE SIZE-DEPTH LATTICE (user spec: "upping the parallax
    // should not just spawn big circles in random positions… it should
    // detect programatically and deterministically using our animate
    // and size and scale random settings and make larger circles and
    // lines appear closer then everything, even icons, and the smaller
    // they get the further they look in parallax. So instead of hard
    // coding it, make it so that it depends on the user settings, where
    // biggest dots and lines parallax the furthest and smallest ones
    // parallax the least. The current effect and method is nice, I like
    // it, but I just would like it to use the user settings instead of
    // hard coding the parallax dots and lines."). The v0.77 spawned
    // starfield (FAR/MID/NEAR orbs at hardcoded pan factors) is GONE;
    // the depth now derives from the LATTICE'S OWN elements:
    //   · each dot's size hash (the user's size-variation + bias warp)
    //     picks its depth band — 5 bands, far→near;
    //   · each LINE's width hash picks the line's band (its segments
    //     ride together — a line stays coherent);
    //   · band k rides pan factor 1 + amp·(0.25 + 0.75·spread_k),
    //     spread ∈ [-0.85, +0.65] — at full amp the pf range is
    //     [0.61, 1.74]: the biggest dots move FASTER than the icons
    //     (pf > 1, in front), the smallest nearly pin (pf < 1, behind);
    //   · uniform sizes (variation off) = the mid plane (pf ≈ 1.18 at
    //     full amp) — the whole lattice floats, no fake stars;
    //   · the biggest elements keep the soft-glow halo + light-lifted
    //     tone of the v0.77 stack (the look the user likes) — on the
    //     USER'S OWN dots, not spawned circles;
    //   · the backdrop camera still slows 0.35 → 0.08 at full amp.
    // amp 0 is the byte-identical single-plane default (ONE band,
    // pf exactly 1, no filter, zero glow).'''
assert old_head in s, 'amp head anchor missing'
s = s.replace(old_head, new_head)

# ── 2. starLayer → the band helpers ──────────────────────────────────────
old_starlayer = re.search(r'    // ── v0\.77 THE AMPLIFIER\'S THREE-LAYER STARFIELD ──.*?^    }\n', s, re.S | re.M)
assert old_starlayer, 'starLayer block missing'
new_helpers = '''    // ── v0.77.9 THE DEPTH-BAND MACHINERY ─────────────────────────────
    // BANDS planes, far → near; the biggest elements ride the LAST band.
    // Deterministic: membership comes from the stable per-cell size
    // hashes (the same ones that size the elements), so nothing shimmers
    // or respawns while sliding — the v0.77 stack's random spawns are
    // gone entirely.
    var AMP_BANDS = 5;
    var bandSpread = function (k) { return -0.85 + 1.5 * (k / (AMP_BANDS - 1)); };
    var bandPF = function (k) { return 1 + amp * (0.25 + 0.75 * bandSpread(k)); };
    // the plane starts: each band wraps its own modulo (the starLayer
    // pattern — self-consistent infinite planes at their own pf)
    var bandStart = function (off, pf, grid) {
      return ((-off * scale * pf) % grid + grid) % grid;
    };
    // membership: the depth rides the SAME hash that sizes the element
    // (uniform sizes → the mid plane, no spread to fake)
    var depthT = function (h, sizeFrac) { return sizeFrac > 0.02 ? h : 0.5; };
    var bandOf = function (t) {
      var k = Math.floor(t * AMP_BANDS);
      return k < 0 ? 0 : (k >= AMP_BANDS ? AMP_BANDS - 1 : k);
    };
    // the near-band glow: the light-lifted tone + the soft halo (the
    // v0.77 look) on the USER'S OWN biggest dots — never spawned ones
    var glowFill = null;
    try {
      var curFill = ctx.fillStyle;
      var mHex2 = /^#([0-9a-fA-F]{6})$/.exec(String(typeof curFill === 'string' ? curFill : ''));
      if (mHex2) glowFill = shadeHex(curFill, 0.42);
    } catch (e) {}
'''
s = s.replace(old_starlayer.group(0), new_helpers, 1)

# ── 3. the FAR/MID callsite → (gone; the bands carry the depth) ─────────
old_far = '''    // the FAR + MID layers paint BEHIND the lattice (true far planes)
    if (!hideDots && amp > 0) {
      starLayer(0.16, 1.65, 0.62, 0.42, 0.48, false, 211);   // FAR — dense, pinned
      starLayer(0.50, 2.20, 1.15, 0.50, 0.68, false, 113);   // MID — half speed
    }

'''
assert old_far in s, 'FAR/MID anchor missing'
s = s.replace(old_far, '')

# ── 4. the lines block → banded passes ──────────────────────────────────
old_lines_open = '''    if (!hideLines) {
      var lineSpec = specs && specs.lineColor;'''
new_lines_open = '''    // v0.77.9: the line passes run PER BAND (far → near); amp 0 is the
    // single unfiltered plane (pf exactly 1 — byte-identical default).
    var lineBands = amp > 0 ? AMP_BANDS : 1;
    var dbgLineBands = [];
    if (!hideLines) {
     for (var lb = 0; lb < lineBands; lb++) {
      var lPF = lineBands === 1 ? 1 : bandPF(lb);
      var lStartX = lineBands === 1 ? startX : bandStart(offsetX, lPF, scaledGrid);
      var lStartY = lineBands === 1 ? startY : bandStart(offsetY, lPF, scaledGrid);
      var lBandN = 0;
      var lineSpec = specs && specs.lineColor;'''
assert old_lines_open in s, 'lines open anchor missing'
s = s.replace(old_lines_open, new_lines_open)

# vertical lines: iterate from lStartX + band-space ix + membership
old_vloop = '''      var segMode = sizeFracL > 0 || animLines;
      var baseSegLen = scaledGrid * 1.35;
      for (let x = startX; x < W; x += scaledGrid) {
        // v0.45 ITEM 6: per-line jitter (scatter + rotation + size)
        var ix = Math.round((x + offsetX * scale) / scaledGrid);'''
new_vloop = '''      var segMode = sizeFracL > 0 || animLines;
      var baseSegLen = scaledGrid * 1.35;
      for (let x = lStartX; x < W; x += scaledGrid) {
        // v0.45 ITEM 6: per-line jitter (scatter + rotation + size)
        var ix = Math.round((x + offsetX * scale * lPF) / scaledGrid);
        // v0.77.9: the line's depth band rides its WIDTH hash — the
        // whole line (all its segments) stays one coherent plane
        if (lineBands > 1 && bandOf(depthT(warpL(hashCell(ix, 2)), sizeFracL)) !== lb) continue;'''
assert old_vloop in s, 'vertical loop anchor missing'
s = s.replace(old_vloop, new_vloop)

# vertical segment y iteration uses lStartY
old_vseg = '''        } else {
          for (let y = startY - scaledGrid; y < H + scaledGrid; y += scaledGrid) {
            var iyS = Math.round((y + offsetY * scale) / scaledGrid);'''
new_vseg = '''        } else {
          for (let y = lStartY - scaledGrid; y < H + scaledGrid; y += scaledGrid) {
            var iyS = Math.round((y + offsetY * scale * lPF) / scaledGrid);'''
assert old_vseg in s, 'vertical segment anchor missing'
s = s.replace(old_vseg, new_vseg)
s = s.replace(old_vseg.replace('lStartY', 'startY').replace('lPF', '1'), new_vseg, 1) if old_vseg.replace('lStartY', 'startY') in s else s

# horizontal lines: same treatment
old_hloop = '''      for (let y = startY; y < H; y += scaledGrid) {
        var iy = Math.round((y + offsetY * scale) / scaledGrid);'''
new_hloop = '''      for (let y = lStartY; y < H; y += scaledGrid) {
        var iy = Math.round((y + offsetY * scale * lPF) / scaledGrid);
        // v0.77.9: the horizontal line's band rides its width hash
        if (lineBands > 1 && bandOf(depthT(warpL(hashCell(2, iy)), sizeFracL)) !== lb) continue;'''
assert old_hloop in s, 'horizontal loop anchor missing'
s = s.replace(old_hloop, new_hloop)

old_hseg = '''        } else {
          for (let x2 = startX - scaledGrid; x2 < W + scaledGrid; x2 += scaledGrid) {
            var ixS = Math.round((x2 + offsetX * scale) / scaledGrid);'''
new_hseg = '''        } else {
          for (let x2 = lStartX - scaledGrid; x2 < W + scaledGrid; x2 += scaledGrid) {
            var ixS = Math.round((x2 + offsetX * scale * lPF) / scaledGrid);'''
assert old_hseg in s, 'horizontal segment anchor missing'
s = s.replace(old_hseg, new_hseg)

# close the band loop after the lines block
old_lines_close = '''        ctx.restore();
      }
    }

    if (!hideDots) {'''
new_lines_close = '''        ctx.restore();
      }
      dbgLineBands.push(lBandN);
     }
    }

    if (!hideDots) {'''
assert old_lines_close in s, 'lines close anchor missing'
s = s.replace(old_lines_close, new_lines_close)

# count band members (lines): increment where the line is drawn — add after the membership check
s = s.replace('''        if (lineBands > 1 && bandOf(depthT(warpL(hashCell(ix, 2)), sizeFracL)) !== lb) continue;''',
'''        if (lineBands > 1 && bandOf(depthT(warpL(hashCell(ix, 2)), sizeFracL)) !== lb) continue;
        lBandN++;''')
s = s.replace('''        if (lineBands > 1 && bandOf(depthT(warpL(hashCell(2, iy)), sizeFracL)) !== lb) continue;''',
'''        if (lineBands > 1 && bandOf(depthT(warpL(hashCell(2, iy)), sizeFracL)) !== lb) continue;
        lBandN++;''')

# ── 5. the dots block → banded passes ───────────────────────────────────
old_dots_open = '''    if (!hideDots) {
      ctx.fillStyle = gridPaint(dotSpec, dotFallback);
      // v0.54: pattern-aware per-dot sampling — each dot picks its color
      // from the SAME gradient/pattern field the background paints
      // (sweeps, mesh spots, checker cells, stripe bands, ray sectors…),
      // world-anchored so panning slides the palette through the lattice
      // without shimmer. (dotSpec/dotSampler live at function scope since
      // v0.76 — the star layers share them.)
      const dotR = dotRBase;
      for (let x = dStartX; x < W; x += scaledGrid) {
        for (let y = dStartY; y < H; y += scaledGrid) {
          // v0.45 ITEM 6: per-dot jitter (scatter + size + rotation)
          var dix = Math.round((x + offsetX * scale) / scaledGrid);
          var diy = Math.round((y + offsetY * scale) / scaledGrid);
          var hd = hashCell(dix, diy);
          // v0.75: the size hash is BIAS-WARPED (favor larger/smaller).
          var hd2 = warpD(hashCell(dix + 7, diy + 7));
          var jx = scatterPxD * (hd - 0.5) * 2;
          var jy = scatterPxD * (hashCell(dix + 3, diy + 5) - 0.5) * 2;
          var jr = dotR * (1 + sizeFracD * (hd2 - 0.5) * 2);'''
new_dots_open = '''    // v0.77.9: the dot passes run PER BAND (far → near); amp 0 is the
    // single unfiltered plane (pf exactly 1 — byte-identical default).
    var dotBands = amp > 0 ? AMP_BANDS : 1;
    var dbgDotBands = [];
    if (!hideDots) {
     for (var db = 0; db < dotBands; db++) {
      var dPF = dotBands === 1 ? 1 : bandPF(db);
      var dStartX2 = dotBands === 1 ? dStartX : bandStart(offsetX, dPF, scaledGrid);
      var dStartY2 = dotBands === 1 ? dStartY : bandStart(offsetY, dPF, scaledGrid);
      var dBandN = 0;
      ctx.fillStyle = gridPaint(dotSpec, dotFallback);
      // v0.54: pattern-aware per-dot sampling — each dot picks its color
      // from the SAME gradient/pattern field the background paints
      // (sweeps, mesh spots, checker cells, stripe bands, ray sectors…),
      // world-anchored so panning slides the palette through the lattice
      // without shimmer. (dotSpec/dotSampler live at function scope.)
      const dotR = dotRBase;
      for (let x = dStartX2; x < W; x += scaledGrid) {
        for (let y = dStartY2; y < H; y += scaledGrid) {
          // v0.45 ITEM 6: per-dot jitter (scatter + size + rotation)
          var dix = Math.round((x + offsetX * scale * dPF) / scaledGrid);
          var diy = Math.round((y + offsetY * scale * dPF) / scaledGrid);
          var hd = hashCell(dix, diy);
          // v0.75: the size hash is BIAS-WARPED (favor larger/smaller).
          var hd2 = warpD(hashCell(dix + 7, diy + 7));
          // v0.77.9: the SIZE picks the DEPTH — biggest = closest
          if (dotBands > 1 && bandOf(depthT(hd2, sizeFracD)) !== db) continue;
          dBandN++;
          var jx = scatterPxD * (hd - 0.5) * 2;
          var jy = scatterPxD * (hashCell(dix + 3, diy + 5) - 0.5) * 2;
          var jr = dotR * (1 + sizeFracD * (hd2 - 0.5) * 2);'''
assert old_dots_open in s, 'dots open anchor missing'
s = s.replace(old_dots_open, new_dots_open)

# the glow halo on the near band's biggest dots (replacing the NEAR layer call site)
old_near = '''          if (dotSampler) ctx.fillStyle = dotSampler(x + jx, y + jy);
          ctx.save();
          if (tal < 1) ctx.globalAlpha = tal;
          ctx.translate(x + jx + tox, y + jy + toy);
          if (jrot) ctx.rotate(jrot * Math.PI / 180);
          ctx.beginPath();
          ctx.arc(0, 0, Math.max(0.15, jr), 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
          dbgDots++;
        }
      }
      // ── v0.77 THE AMPLIFIER'S NEAR LAYER ──
      // A sparse FOREGROUND of big soft-glow orbs riding pan factor 1.6 —
      // FASTER than the lattice, the strongest depth cue (close dust), in
      // a light-lifted tone so they actually READ on dark themes.
      if (amp > 0) {
        starLayer(1.6, 4.0, 4.2, 0.55, 0.92, true, 307);
      }
    }'''
new_near = '''          if (dotSampler) ctx.fillStyle = dotSampler(x + jx, y + jy);
          // v0.77.9: the near band's BIGGEST dots catch the light — the
          // v0.77 glow look on the user's own elements (a halo under the
          // core + the light-lifted tone), never spawned circles
          var nearGlow = dotBands > 1 && db === AMP_BANDS - 1 &&
            jr >= dotRBase * 1.6 && glowFill;
          if (nearGlow) ctx.fillStyle = glowFill;
          ctx.save();
          if (tal < 1) ctx.globalAlpha = tal;
          if (nearGlow && jr >= 1.6) {
            try {
              var hg2 = ctx.createRadialGradient(x + jx + tox, y + jy + toy, jr * 0.35, x + jx + tox, y + jy + toy, jr * 2.6);
              hg2.addColorStop(0, ctx.fillStyle);
              hg2.addColorStop(1, 'rgba(0,0,0,0)');
              var ga = ctx.globalAlpha;
              ctx.globalAlpha = ga * 0.55;
              ctx.beginPath();
              ctx.arc(x + jx + tox, y + jy + toy, jr * 2.6, 0, Math.PI * 2);
              ctx.fillStyle = hg2;
              ctx.fill();
              ctx.globalAlpha = ga;
              if (dotSampler) ctx.fillStyle = dotSampler(x + jx, y + jy);
              if (glowFill) ctx.fillStyle = glowFill;
            } catch (e) {}
          }
          ctx.translate(x + jx + tox, y + jy + toy);
          if (jrot) ctx.rotate(jrot * Math.PI / 180);
          ctx.beginPath();
          ctx.arc(0, 0, Math.max(0.15, jr), 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
          dbgDots++;
        }
      }
      dbgDotBands.push(dBandN);
     }
    }'''
assert old_near in s, 'near layer anchor missing'
s = s.replace(old_near, new_near)

# ── 6. the debug counters ───────────────────────────────────────────────
old_dbg = '''    // v0.75: the honest instrument — the suite's parallax proof and any
    // future red-team read the last frame's counters (stars/dots/segs).
    window.DoomalayDebug = { stars: dbgStars, dots: dbgDots, segs: dbgSegs, amp: amp };'''
new_dbg = '''    // v0.75: the honest instrument — the suite's parallax proof and any
    // future red-team read the last frame's counters. v0.77.9: stars is
    // always 0 (the spawned starfield is retired); the per-band counts +
    // pan factors carry the size-depth contract.
    window.DoomalayDebug = { stars: 0, dots: dbgDots, segs: dbgSegs, amp: amp,
      dotBands: dbgDotBands, lineBands: dbgLineBands };'''
assert old_dbg in s, 'debug anchor missing'
s = s.replace(old_dbg, new_dbg)

# dbgStars no longer accumulates (no starLayer) — drop the var to avoid lint noise
s = s.replace('var dbgStars = 0, dbgDots = 0, dbgSegs = 0;', 'var dbgDots = 0, dbgSegs = 0;')

open(P, 'w', encoding='utf-8').write(s)
print('app.js patched:', len(orig), '→', len(s), 'bytes')
