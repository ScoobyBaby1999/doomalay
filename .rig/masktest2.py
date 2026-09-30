#!/usr/bin/env python3
"""Does the outline mask-ring hide (a) element children, (b) TEXT-only content?"""
from playwright.sync_api import sync_playwright
from PIL import Image

HTML = """<!DOCTYPE html><html><head><style>
:root { --border: #ff00ff; }
[style*="solid var(--border)"][style*="background:transparent"] {
  background-image: linear-gradient(45deg, #f0f, #0ff) !important;
  background-attachment: fixed !important;
  border-color: transparent !important;
  -webkit-mask: linear-gradient(#fff 0 0) padding-box, linear-gradient(#fff 0 0);
  -webkit-mask-composite: xor;
  mask: linear-gradient(#fff 0 0) padding-box, linear-gradient(#fff 0 0);
  mask-composite: exclude;
}
</style></head><body style="background:#111;color:#ccc;margin:20px;font-family:sans-serif">
<button id="withchild" style="background:transparent;border:1px solid var(--border);padding:8px 12px;color:#eee">
  <i style="width:12px;height:12px;border-radius:50%;background:#22d3ee;display:inline-block"></i> label
</button>
<button id="textonly" style="background:transparent;border:1px solid var(--border);padding:8px 12px;color:#eee;margin-left:20px">text label only</button>
</body></html>"""

with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={"width": 640, "height": 200})
    pg.set_content(HTML); pg.wait_for_timeout(200)
    res = pg.evaluate("""() => {
      function box(id) { const r = document.getElementById(id).getBoundingClientRect(); return {x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)}; }
      return {wc: box('withchild'), to: box('textonly')};
    }""")
    pg.screenshot(path="/home/z/doomalay/.rig/mask_test2.png")
    im = Image.open("/home/z/doomalay/.rig/mask_test2.png").convert("RGB")
    # probe: withchild — dot center; textonly — center of the button (where text glyphs are)
    wc, to = res["wc"], res["to"]
    # sample a horizontal strip through the textonly button center; count non-background pixels
    import collections
    def strip_stats(box):
        lit = 0
        for x in range(box["x"] + 4, box["x"] + box["w"] - 4):
            px = im.getpixel((x, box["y"] + box["h"] // 2))
            if px != (17, 17, 17) and px != (18, 18, 18):
                lit += 1
        return lit
    print("withchild lit columns at mid-height:", strip_stats(wc))
    print("textonly  lit columns at mid-height:", strip_stats(to))
    print("textonly box:", to)
    b.close()
