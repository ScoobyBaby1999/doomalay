#!/usr/bin/env python3
"""Empirical check: does the v0.77.8 outline mask-ring hide chip children?"""
from playwright.sync_api import sync_playwright

HTML = """<!DOCTYPE html><html><head><style>
:root { --border: #ff00ff; }
[style*="solid var(--border)"][style*="background:transparent"],
[style*="solid var(--border)"][style*="background-color: transparent"],
[style*="solid var(--border)"]:not([style*="background"]) {
  background-image: linear-gradient(45deg, #f0f, #0ff) !important;
  background-attachment: fixed !important;
  border-color: transparent !important;
  -webkit-mask: linear-gradient(#fff 0 0) padding-box, linear-gradient(#fff 0 0);
  -webkit-mask-composite: xor;
  mask: linear-gradient(#fff 0 0) padding-box, linear-gradient(#fff 0 0);
  mask-composite: exclude;
}
</style></head><body style="background:#111;color:#ccc;margin:20px">
<button id="chip" style="display:flex;align-items:center;gap:6px;background:transparent;border:1px solid var(--border);border-radius:10px;padding:8px 12px;color:#9aa;font-weight:600">
  <span style="display:flex">
    <i style="width:12px;height:12px;border-radius:50%;background:#22d3ee;display:inline-block"></i>
    <i style="width:12px;height:12px;border-radius:50%;background:#a78bfa;display:inline-block;margin-left:-3px"></i>
  </span>teal</button>
<br><br>
<button id="ctrl" style="display:flex;align-items:center;gap:6px;background:transparent;border:1px solid #666;border-radius:10px;padding:8px 12px;color:#9aa;font-weight:600">
  <span style="display:flex">
    <i style="width:12px;height:12px;border-radius:50%;background:#22d3ee;display:inline-block"></i>
  </span>control</button>
</body></html>"""

with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={"width": 500, "height": 300}, device_scale_factor=1)
    pg.set_content(HTML)
    pg.wait_for_timeout(200)
    # pixel-probe the two dot regions
    res = pg.evaluate("""() => {
      function probe(id) {
        const btn = document.getElementById(id);
        const dot = btn.querySelector('i');
        const r = dot.getBoundingClientRect();
        return {x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2),
                w: Math.round(r.width), h: Math.round(r.height)};
      }
      return {chip: probe('chip'), ctrl: probe('ctrl')};
    }""")
    pg.screenshot(path="/home/z/doomalay/.rig/mask_test.png")
    from PIL import Image
    im = Image.open("/home/z/doomalay/.rig/mask_test.png").convert("RGB")
    for name, d in res.items():
        px = im.getpixel((d["x"], d["y"]))
        print(name, "dot center pixel:", px, "(teal would be ~(34,211,238))")
    b.close()
