#!/usr/bin/env python3
# v1390-theme-source-pin.py — THE SOURCE PIN (v1.39.0, house convention).
#
# The user's directive: "a source-pin test that fails on any new literal
# color outside the theme file — the discipline becomes enforceable."
#
# HOW IT WORKS (the lint-baseline pattern — Android lint / ruff #1149):
#   1. Re-runs the v1390 census (the full literal-color sweep of web/,
#      comment-stripped, context-classified into the documented zones of
#      docs/DISCIPLINE.md).
#   2. Every occurrence in a MECHANICALLY-SAFE zone passes (var-composition,
#      theme-def, engine, fmt, picker, brand, mask-shape, transparent-end,
#      … — the zone list below).
#   3. Everything else must appear in the committed baseline
#      (scripts/v1390-theme-pin-baseline.json) — today exactly the NINE
#      known violations the v1390 audit enumerated.
#   4. FAILS on: any occurrence NOT in the baseline (a NEW literal),
#      any baseline entry no longer present (STALE — the ledger must stay
#      honest; delete the entry when you fix the literal), any anti-rot
#      marker gone (a zone range whose documenting code comment vanished).
#
# Update flow (explicit, reviewed): fix the literal OR document the zone
# in the census + rerun with --update. Never delete a gate (DISCIPLINE.md).
#
# Wire-in: scripts/v1040-discipline-audit.sh gate A5. Battery-safe (fast,
# static, exit-code only).

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import importlib.util
_spec = importlib.util.spec_from_file_location(
    'v1390census', os.path.join(HERE, 'v1390-theme-census.py'))
_c = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_c)

BASELINE = os.path.join(HERE, 'v1390-theme-pin-baseline.json')

# zones that pass WITHOUT a baseline entry (mechanically derivable —
# the classifier itself is the proof). Everything else needs an entry.
# NOTE: zero-black/white-constant are NOT blanket-safe — a bare black/
# white literal outside an adjudicated zone (theme block, picker, crop,
# glow, yt letterbox) is exactly how the elevation-era violations crept
# in; the census must zone each one and the baseline must carry it.
SAFE_ZONES = {
    'var-composition', 'dynamic-var-composition', 'theme-def', 'engine',
    'fmt', 'picker', 'gradient-engine', 'brand', 'ink-on-art', 'media-black',
    'mask-shape', 'transparent-end', 'zero-point', 'mix-endpoint',
    'var-fallback', 'not-a-color',
    'svg-ref', 'id-selector', 'canon-marker', 'harness-twin', 'self-test',
    'probe-paint', 'converter', 'crop',
}

def key(occ):
    return '%s:%d:%s:%s' % (occ[0], occ[1], occ[2], occ[3])

def main():
    update = '--update' in sys.argv
    rows, _ = _c.main.__wrapped__() if hasattr(_c.main, '__wrapped__') else (None, None)
    return run(rows, update)

def run(rows, update):
    # rows: list of (file, line, kind, token, zone, excerpt)
    flagged = []
    for r in rows:
        if r[4] in SAFE_ZONES:
            continue
        flagged.append(r)
    ledger = sorted(set(key(r) + '|' + r[4] for r in flagged))

    # ── anti-rot: every zone range's marker must still exist ──
    marker_fail = []
    texts = {}
    for (rf, a, b, rz, label) in _c.RANGE_ZONES:
        if label not in _c.RANGE_MARKERS:
            marker_fail.append('range %s has no RANGE_MARKERS entry' % label)
            continue
        marker = _c.RANGE_MARKERS[label]
        if rf not in texts:
            texts[rf] = open(os.path.join(_c.WEB, rf), encoding='utf-8',
                             errors='replace').read()
        if marker not in texts[rf]:
            marker_fail.append('%s: marker %r gone (zone %s rotted)' % (rf, marker, label))

    if update:
        data = {
            '_doc': ('THE SOURCE-PIN BASELINE — every literal-color occurrence '
                     'outside the mechanically-safe zones. New literal → the pin '
                     'fails; fix it or document its zone in v1390-theme-census.py '
                     'and --update. Stale entries fail too (delete when fixed). '
                     'known-violation = the v1390 audit\'s enumerated findings '
                     '(see docs/THEME-AUDIT-V139.md for the re-slot proposals).'),
            'entries': ledger,
        }
        with open(BASELINE, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=1, sort_keys=True)
        print('baseline updated: %d entries' % len(ledger))
        return 0

    with open(BASELINE, encoding='utf-8') as f:
        base = json.load(f)
    entries = set(base['entries'])

    new = [k for k in ledger if k not in entries]
    stale = [k for k in sorted(entries) if k not in set(ledger)]

    fails = []
    for k in new:
        fails.append('NEW literal color outside the canonical zones: %s' % k)
    for k in stale:
        fails.append('STALE baseline entry (literal gone/moved — update the ledger): %s' % k)
    fails.extend(marker_fail)

    known = [k for k in ledger if k in entries and '|known-violation' in k]
    print('source-pin: %d occurrences outside safe zones; %d baselined '
          '(%d known-violations); %d NEW; %d STALE; %d marker fails'
          % (len(ledger), len(entries), len(known), len(new), len(stale),
             len(marker_fail)))
    for f in fails:
        print('FAIL %s' % f)
    print('v1390 source-pin: %s' % ('PASS' if not fails else 'FAIL'))
    return 0 if not fails else 1

if __name__ == '__main__':
    # build the census rows without the stdout flood
    import io, contextlib
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        rows, _ok = _c.main()
    sys.exit(run(rows, '--update' in sys.argv))
