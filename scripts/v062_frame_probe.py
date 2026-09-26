#!/usr/bin/env python3
"""v062 frame-ability probe — can the app IFRAME the pages it wants to show?

Probes the real "Get API key ↗" targets (engine/internal/llm/catalog/
providers.json), the YouTube surfaces, and a few controls, then prints the
embedding verdict per URL based on the response headers:

  x-frame-options: DENY|SAMEORIGIN  → browser refuses the iframe
  content-security-policy: frame-ancestors 'none'|'self'|<list> → refuses
  neither header → embeddable (CSP frame-ancestors wins over XFO when both)

Verdicts are about TOP-LEVEL framing by our app origin — the APK WebView
can still show any page via full-page navigation (SAMEORIGIN only governs
iframes), which is a separate column of the design.
"""
import json
import ssl
import urllib.request

UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"}

TARGETS = [
    # ── the app's real "Get API key ↗" targets (providers.json) ──
    ("openrouter", "https://openrouter.ai/keys"),
    ("openai", "https://platform.openai.com/api-keys"),
    ("anthropic", "https://console.anthropic.com/settings/keys"),
    ("groq", "https://console.groq.com/keys"),
    ("mistral", "https://console.mistral.ai/api-keys"),
    ("deepseek", "https://platform.deepseek.com/api_keys"),
    ("together", "https://api.together.ai/settings/api-keys"),
    ("nvidia", "https://build.nvidia.com/settings/api-keys"),
    ("cloudflare", "https://dash.cloudflare.com/profile/api-tokens"),
    ("privatemode", "https://portal.privatemode.ai/api-keys"),
    ("github-tokens", "https://github.com/settings/tokens"),
    ("hf-tokens", "https://huggingface.co/settings/tokens"),
    # ── YouTube surfaces ──
    ("youtube-watch", "https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
    ("youtube-nocookie-embed", "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"),
    ("youtube-thumb", "https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg"),
    # ── other pages the LLM might link ──
    ("wikipedia", "https://en.wikipedia.org/wiki/Rickroll"),
    ("github-repo", "https://github.com/ScoobyBaby1999/doomalay"),
    ("hf-space", "https://huggingface.co/spaces"),
    ("arxiv", "https://arxiv.org/abs/1706.03762"),
    ("example-frameable", "https://example.com/"),
]


def probe(name, url):
    ctx = ssl.create_default_context()
    out = {"name": name, "url": url}
    try:
        req = urllib.request.Request(url, headers=UA)
        with urllib.request.urlopen(req, timeout=20, context=ctx) as r:
            out["status"] = r.status
            out["xfo"] = (r.headers.get("x-frame-options") or "").strip()
            csp = r.headers.get("content-security-policy") or ""
            out["fa"] = ""
            for pol in csp.split(";"):
                p = pol.strip()
                if p.lower().startswith("frame-ancestors"):
                    out["fa"] = p
            out["ct"] = (r.headers.get("content-type") or "").split(";")[0]
    except Exception as e:
        out["status"] = f"ERR {type(e).__name__}: {str(e)[:80]}"
    # verdict: what blocks OUR origin from framing it?
    fa, xfo = out.get("fa", ""), out.get("xfo", "").upper()
    if "ERR" in str(out["status"]):
        out["verdict"] = "unreachable-headless"
    elif "frame-ancestors" in fa:
        if "'none'" in fa or "none" in fa:
            out["verdict"] = "BLOCKED (csp frame-ancestors none)"
        elif "'self'" in fa:
            out["verdict"] = "BLOCKED (csp frame-ancestors self)"
        else:
            out["verdict"] = f"CONDITIONAL ({fa[:60]})"
    elif xfo in ("DENY",):
        out["verdict"] = "BLOCKED (xfo deny)"
    elif xfo in ("SAMEORIGIN", "SAMEORIGIN, ALLOW-FROM"):
        out["verdict"] = "BLOCKED (xfo sameorigin)"
    else:
        out["verdict"] = "EMBEDDABLE (no framing guard)"
    return out


rows = [probe(n, u) for n, u in TARGETS]
print(json.dumps(rows, indent=1))
print("\n=== SUMMARY ===")
for r in rows:
    print(f"{r['name']:24} {str(r['status']):>7}  {r['verdict']}  xfo={r.get('xfo','')!r:16} fa={r.get('fa','')[:50]}")
