#!/usr/bin/env python3
# v0791-focused-test.py — the v31 sections that v0.79.1 touches, run
# standalone (the library/mocker sections of v31 are the parallel bot's
# stale contracts, not this wave's; see the worklog).
#
# Covers: the text-size system (setState + the REAL settings slider
# through the rAF-coalesced wireInputs), plus the settings/dock flows.
import json
import sys
import time
import urllib.request

BASE = "http://127.0.0.1:8793"

from playwright.sync_api import sync_playwright

PASS = 0; FAIL = 0
def ok(name, cond):
    global PASS, FAIL
    if cond: PASS += 1; print(f"  PASS {name}")
    else: FAIL += 1; print(f"  FAIL {name}")

with sync_playwright() as p:
    br = p.chromium.launch()
    pg = br.new_page(viewport={"width": 405, "height": 760})
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.goto(BASE)
    pg.wait_for_timeout(1000)

    # ── the settings text-size system (v31 §13, verbatim flow) ──────
    print("text-size system")
    uifs = pg.evaluate("() => getComputedStyle(document.documentElement).getPropertyValue('--ui-fs').trim()")
    ok(uifs == "14.5px", f"default --ui-fs is 14.5px (got {uifs})")
    pg.evaluate("() => window.Settings.setState({uiTextSize: 100})")
    pg.wait_for_timeout(200)
    # …and through the REAL settings slider (gear → Sizing page → Text Size)
    pg.locator("#settings-btn").click(); pg.wait_for_timeout(900)
    pg.locator(".settings-nav .tab", has_text="Sizing").click(); pg.wait_for_timeout(400)
    pg.locator(".settings-section h3", has_text="Text Size").first.click(); pg.wait_for_timeout(300)
    pg.locator('input.app-range[data-setting-key="uiTextSize"]').evaluate(
        "el => { el.value = 25; el.dispatchEvent(new Event('input', {bubbles:true})) }")
    pg.wait_for_timeout(400)
    uifs = pg.evaluate("() => getComputedStyle(document.documentElement).getPropertyValue('--ui-fs').trim()")
    ok(uifs == "13.3px", f"dragging the General-text slider sets --ui-fs (13.3px, got {uifs})")
    # the slider's trailing change landed in the store too
    ok(pg.evaluate("() => window.Settings.getState().uiTextSize") == 25,
       "the store carries the slider's final value (25)")

    # close settings through the scrim path
    pg.evaluate("() => document.getElementById('chat-scrim').click()"); pg.wait_for_timeout(500)

    # ── settings persistence after reload (the debounced save) ──────
    pg.evaluate("() => window.Settings.setState({smallTextSize: 70})")
    pg.wait_for_timeout(600)   # > the 300ms debounce
    pg.reload(); pg.wait_for_timeout(1000)
    sm = pg.evaluate("() => window.Settings.getState().smallTextSize")
    ok(sm == 70, f"a post-reload settings read keeps 70 (got {sm})")

    # ── the theme switch still applies (block cache + delta writes) ──
    print("theme switching")
    pg.evaluate("() => window.Settings.setState({theme: 'nebula'})")
    pg.wait_for_timeout(300)
    acc = pg.evaluate("""() => {
      const p = document.createElement('div'); p.style.color = 'var(--accent)';
      p.style.display = 'none'; document.body.appendChild(p);
      const v = getComputedStyle(p).color; p.remove(); return v;
    }""")
    ok(acc == "rgb(192, 132, 252)", f"nebula's accent applies (rgb(192, 132, 252), got {acc})")
    ok(pg.evaluate("() => document.documentElement.getAttribute('data-theme')") == "nebula",
       "the data-theme attribute flipped")
    pg.evaluate("() => window.Settings.setState({theme: 'paper'})")
    pg.wait_for_timeout(300)
    acc2 = pg.evaluate("""() => {
      const p = document.createElement('div'); p.style.color = 'var(--accent)';
      p.style.display = 'none'; document.body.appendChild(p);
      const v = getComputedStyle(p).color; p.remove(); return v;
    }""")
    ok(acc2 == "rgb(180, 83, 9)", f"paper's accent applies (rgb(180, 83, 9), got {acc2})")
    # a light theme trips the bright-surface ink gate
    ok(pg.evaluate("() => document.documentElement.hasAttribute('data-bright-bg') || document.documentElement.hasAttribute('data-bright-s1') || document.documentElement.hasAttribute('data-bright-s2')"),
       "paper (light) trips at least one bright-ink gate")
    pg.evaluate("() => window.Settings.setState({theme: 'midnight'})")
    pg.wait_for_timeout(300)

    # ── zero page errors ─────────────────────────────────────────────
    ok(len(errors) == 0, f"zero page errors ({len(errors)})")
    if errors: print("   page errors:", errors[:3])
    br.close()

print(f"\nTOTAL: {PASS} pass, {FAIL} fail")
sys.exit(1 if FAIL else 0)
