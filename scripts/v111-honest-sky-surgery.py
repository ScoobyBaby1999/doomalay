#!/usr/bin/env python3
"""v1.10.2 THE HONEST SKY — tlBakeWalk surgery (heroes/glow/over-split retired).
Marker-based: every edit asserts its anchor line exists exactly once."""
import sys

FP = "engine/internal/server/web/lattice.js"
src = open(FP).read()
lines = src.split("\n")


def find_one(marker, lo=0):
    hits = [i for i in range(lo, len(lines))
            if lines[i] is not None and marker in lines[i]]
    assert len(hits) == 1, f"marker {marker!r}: {len(hits)} hits"
    return hits[0]


def find_first(marker, lo=0):
    hits = [i for i in range(lo, len(lines))
            if lines[i] is not None and marker in lines[i]]
    assert hits, f"marker {marker!r}: none"
    return hits[0]


def splice(start, end, replacement):  # inclusive line indices
    lines[start:end + 1] = replacement


# ── 1. the firefly-budget comment + HERO_PER_TILE → the v1.10.2 note ──
i = find_one("var HERO_PER_TILE = 5;")
splice(i - 6, i, [
    "    // v1.10.2 THE HONEST SKY — the amplifier's three mis-features are",
    "    // retired, per the user's spec: \"amplify parallax uses the existing",
    "    // dots and stars, and moves them in a parallax sort of fashion… No",
    "    // need to introduce more brighter stars, just use the current stars",
    "    // and lines\".",
    "    //   · THE HERO FIREFLIES minted ONLY when amp > 0 (the topBand gate),",
    "    //     up to 40 live glowing movers repeating at the tile period —",
    "    //     \"it introduces many of them and they look tiled\". GONE.",
    "    //   · THE STATIC GLOW (halo sprite + shadeHex-lifted cores) on the",
    "    //     top-band big dots — \"large bright stars, brighter than any star",
    "    //     in the entire grid when amplify parallax is off\". GONE.",
    "    //   · THE OVER-ICONS SPLIT (overDotsOn = amp >= 0.5 && effFrac >",
    "    //     0.02) baked the biggest dots/lines into over-tiles painted on",
    "    //     #c2 — \"stars… that have a size of >= 80 max size variation",
    "    //     appear to render over icons\". GONE — all paint UNDER icons.",
    "    // The BAND SPLIT stays: the same dots/lines at per-depth parallax",
    "    // factors — \"moves them in a parallax sort of fashion\" — and the",
    "    // visible population is now byte-identical to amp = 0's.",
])

# ── 2. the hero pre-pass + the mint (topBand … T.jrMin assignment) ──
i = find_one("var topBand = (amp > 0) && band === AMP_BANDS - 1;")
j = find_one("T.jrMin = Tj.jrMin; T.jrMax = Tj.jrMax;")
assert j > i
splice(i, j, [
    "      // (the hero pre-pass is retired with the fireflies; the jrMin/jrMax",
    "      // instrument now rides the static walk below)",
])

# ── 3. the over-tile mint → plain tile ──
i = find_one("var tile = mkTile(ML), overTile = (overDotsOn && topBand) ? mkTile(ML) : null;")
lines[i] = "        var tile = mkTile(ML);"

# ── 4. the heroSet skip ──
i = find_one("if (heroSet[gi + ':' + dx + ',' + dy]) continue;")
lines[i] = None  # mark for deletion

# ── 5. the over-target pick → the tile itself ──
i = find_one("var isOver = overDotsOn && jrB > overThreshD;")
assert "var tgt = isOver ? overTile : tile;" in lines[i + 1]
assert lines[i + 2].strip() == "if (!tgt) continue;"
assert "var gg = tgt.g;" in lines[i + 3]
splice(i, i + 3, ["          var gg = g;"])

# ── 6. the ext glow inflation ──
i = find_one("var ext = rr + ((topBand && jrB >= dotRBaseQ * 1.6) ? jrB * 2.6 : 0);")
lines[i] = "          var ext = rr;"

# ── 7. the static-glow block ──
i = find_one("// the static glow: halo sprite + lifted core color, per-dot —")
j = find_one("var fillStyle = styleD;")
assert j > i
splice(i, j - 1, [])

# ── 8. tgt.* stats → tile.* (the DOT walk's instance — the segment walk
# keeps its own tgt, which is now always the tile anyway) ──
i = find_one("gg.beginPath(); gg.arc(wx, wy, rr, 0, Math.PI * 2); gg.fill();")
i = find_first("tgt.n++;", lo=i)
lines[i] = "          tile.n++;"
i = find_first("if (rr < dotRBaseQ * 0.9) tgt.small++; else if (rr > dotRBaseQ * 1.1) tgt.big++;", lo=i)
lines[i] = "          if (rr < dotRBaseQ * 0.9) tile.small++; else if (rr > dotRBaseQ * 1.1) tile.big++;"

# ── 9. the over-tile push + cellRecords ternary (dot walk only) ──
i = find_one("if (overTile && overTile.n > 0) T.list.push({ kind: gi === 0 ? 'dotsA' : 'dotsB', band: band, pf: pf, over: true, tile: overTile });")
lines[i] = None
i = find_first("T.cellRecords += tile.n + (overTile ? overTile.n : 0);", lo=i - 5)
lines[i] = "        T.cellRecords += tile.n;"

lines = [l for l in lines if l is not None]
open(FP, "w").write("\n".join(lines))
print("tlBakeWalk surgery done:", len(src.split(chr(10))), "->", len(lines), "lines")
