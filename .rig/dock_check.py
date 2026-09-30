#!/usr/bin/env python3
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={"width": 420, "height": 800}, device_scale_factor=2)
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto("http://127.0.0.1:8099"); pg.wait_for_timeout(2500)
    g = pg.locator("#settings-btn").bounding_box()
    t = pg.locator("#dock-toggle").bounding_box()
    print("gear:", g)
    print("toggle:", t)
    # arrow below gear, right aligned
    assert abs(g["width"] - 44) < 1, "gear not 44px"
    assert t["y"] >= g["y"] + g["height"] - 2, "arrow not below gear"
    assert abs((t["x"] + t["width"]) - (g["x"] + g["width"])) < 2, "arrow not right-aligned"
    pg.locator("#dock-toggle").click(); pg.wait_for_timeout(400)
    s = pg.locator("#dock-strip").bounding_box()
    print("strip:", s)
    assert s["y"] >= t["y"] + t["height"] - 2, "strip not below arrow"
    assert abs((s["x"] + s["width"]) - (g["x"] + g["width"])) < 2, "strip not right-aligned"
    pg.screenshot(path="/home/z/doomalay/.rig/dock_v791.png")
    print("errors:", errs)
    assert not errs, "page errors!"
    print("DOCK v0.79.1 OK")
    b.close()
