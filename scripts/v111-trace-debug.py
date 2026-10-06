#!/usr/bin/env python3
# minimal CDP tracing probe — is Tracing.dataCollected delivered on a page session?
import time
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page()
    pg.goto("data:text/html,<html><body><div id=x>hi</div></body></html>")
    cdp = b.new_browser_cdp_session()
    evs = []
    done = {"v": False}
    cdp.on("Tracing.dataCollected", lambda v: evs.extend(v.get("value", [])))
    cdp.on("Tracing.tracingComplete", lambda v: done.__setitem__("v", True))
    cdp.send("Tracing.start", {"traceConfig": {
        "recordMode": "recordAsMuchAsPossible",
        "includedCategories": ["devtools.timeline", "disabled-by-default-devtools.timeline"]}})
    pg.evaluate("() => { for (let i = 0; i < 200; i++) document.getElementById('x').style.transform = 'translateX(' + i + 'px)'; }")
    time.sleep(0.5)
    cdp.send("Tracing.end")
    for _ in range(40):
        if done["v"]:
            break
        time.sleep(0.1)
    print("complete:", done["v"], "events:", len(evs))
    from collections import Counter
    names = Counter(e.get("name", "") for e in evs)
    print("top:", names.most_common(12))
    b.close()
