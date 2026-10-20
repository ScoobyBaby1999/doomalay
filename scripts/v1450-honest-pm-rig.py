#!/usr/bin/env python3
# v1450-honest-pm-rig.mjs...py — v1.45.5 THE PROOF (PLAN-V145 §5): the live
# red-team battery for THE HONEST PM, driven the way the real user drives
# the app (a real browser on a real engine, real keys, the user's exact
# device shape: PM unreachable while Nvidia/OpenRouter work).
#
#   PM_KEY=... NV_KEY=... [OR_KEY=...] python3 scripts/v1450-honest-pm-rig.py
#
# ARMS:
#   RA  the honest net, engine arm — a REAL Nvidia turn first (health
#       evidence), then a dead-PM turn: the texts NEVER say "network",
#       the bounded hold terminalizes with the provider-down verdict,
#       the session lock RELEASES (the fresh send is not busy).
#   RB  the pill objects — 3 live provider chats, rapid switching with a
#       MutationObserver on every pill mutation: every provider-naming
#       pill text must match the chat open at that moment (ZERO
#       cross-chat leaks — the user's law).
#   RC  the stash path — the live pill survives panel-close + reopen with
#       the CURRENT phase text (no baked-stale flash, no 500ms blank).
#   RD  the quiet oracle — opening the PM chat fires ZERO /vendor/pm/*,
#       wasm, attest, or ticket requests (the v1.44.4 auto-nudge is dead).
#   RE  the source pins — netx in pmstate, PROVENANCE delta 8, the honest
#       ladder texts, no auto-wasm in the chat UI, the true counter.
#
# Honest limits (documented): the Android DNS conviction is by-construction
# (netx is the proven Android path the working providers ride; live Android
# proof needs the user's device — the tunnel was down this session; the
# unit pin TestManagerDialsViaNetx guards the wiring). The device-offline
# infinite-patient law is owned by the v1400 battery + TestV1452 pins.
import json, os, shutil, subprocess, sys, tempfile, time, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENG = os.path.join(ROOT, "engine")
PORT = 8146
BASE = f"http://127.0.0.1:{PORT}"
PM_KEY = os.environ.get("PM_KEY", "")
NV_KEY = os.environ.get("NV_KEY", "")
if not PM_KEY or not NV_KEY:
    print("FATAL: set PM_KEY and NV_KEY (real keys — the rig is LIVE)"); sys.exit(1)

ok_n = fail_n = 0
def check(name, cond, detail=""):
    global ok_n, fail_n
    if cond: ok_n += 1; print(f"  ✓ {name}")
    else: fail_n += 1; print(f"  FAIL {name}" + (f" — {detail}" if detail else ""))

def api(path, body=None, method=None):
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode() if body is not None else None,
                                 method=method or ("POST" if body is not None else "GET"),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode() or "{}")

# ── the engine (the user's device shape: PM dead, others real) ─────────
go = os.environ.get("GO", shutil.which("go") or "/home/z/sdk/go/bin/go")
data = tempfile.mkdtemp(prefix="v1450-")
binpath = os.path.join(tempfile.gettempdir(), "doomalay-v1450")
subprocess.run([go, "build", "-o", binpath, "./cmd/doomalay"], cwd=ENG, check=True)
env = dict(os.environ,
           DOOMALAY_OTA_DISABLE="1",
           DOOMALAY_PM_API_BASE="http://127.0.0.1:9",       # the device shape: PM unreachable
           DOOMALAY_NET_LADDER_WAITS="500,800,1000,1200,1400",
           DOOMALAY_NET_SUSPEND_BASE_MS="800", DOOMALAY_NET_SUSPEND_CAP_MS="1600",
           DOOMALAY_NET_HEARTBEAT_MS="400",
           DOOMALAY_PROVIDER_HOLD_MS="4000",                # the bounded hold, compressed
           DOOMALAY_PROVIDER_HEALTH_WINDOW_MS="3600000")
proc = subprocess.Popen([binpath, "-port", str(PORT), "-data-dir", data, "-open=false"],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env)
for _ in range(60):
    try: api("/api/health"); break
    except Exception: time.sleep(0.4)
else:
    print("FATAL: engine did not start"); sys.exit(1)
try:
    api("/api/keys", {"provider": "privatemodeai", "env_var": "PRIVATEMODEAI_API_KEY", "key": PM_KEY})
    api("/api/keys", {"provider": "nvidia", "env_var": "NVIDIA_API_KEY", "key": NV_KEY})
    sid_nv = api("/api/sessions", {"title": "NvRig", "sandbox": "quick", "provider": "nvidia", "model": "nvidia/z-ai/glm-5.3-flash"})["ID"]
    sid_pm = api("/api/sessions", {"title": "PmRig", "sandbox": "quick", "provider": "privatemodeai", "model": "privatemodeai/glm-5.3-flash"})["ID"]
    sid_or = api("/api/sessions", {"title": "OrRig", "sandbox": "quick", "provider": "openrouter", "model": "openrouter/minimax/minimax-m3.1-flash:free"})["ID"] \
        if os.environ.get("OR_KEY") else None
    if sid_or:
        api("/api/keys", {"provider": "openrouter", "env_var": "OPENROUTER_API_KEY", "key": os.environ["OR_KEY"]})

    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1280, "height": 900})
        reqlog = []
        page.on("request", lambda r: reqlog.append(r.url))
        page.goto(BASE); page.wait_for_timeout(4000)

        def js(expr):
            return page.evaluate(expr)

        js("""(() => {
          window.__pillLog = []; window.__curChat = 'none';
          const pillTxt = n => { try { return (n.querySelector('.cwt')||{}).textContent || ''; } catch (e) { return ''; } };
          const hdr = () => { try { const p = document.querySelector('[id^=pill-model]');
            return p ? (p.textContent||'').replace(/\\s+/g,' ').slice(0,44) : '?'; } catch (e) { return '?'; } };
          const mo = new MutationObserver(muts => { const now = Date.now();
            for (const m of muts) {
              if (m.type === 'childList') {
                m.addedNodes.forEach(n => { if (n.classList && n.classList.contains('chat-working'))
                  window.__pillLog.push({t:now,c:window.__curChat,h:hdr(),ev:'ADD',x:pillTxt(n)}); });
                m.removedNodes.forEach(n => { if (n.classList && n.classList.contains('chat-working'))
                  window.__pillLog.push({t:now,c:window.__curChat,h:hdr(),ev:'DEL',x:pillTxt(n)}); });
              } else if (m.type === 'characterData' && m.target.parentElement &&
                         m.target.parentElement.classList.contains('cwt')) {
                window.__pillLog.push({t:now,c:window.__curChat,h:hdr(),ev:'TXT',x:m.target.parentElement.textContent});
              }
            } });
          mo.observe(document.body, {subtree:true, childList:true, characterData:true});
          window.__pillMO = mo; })()""")

        def open_chat(sid, marker):
            js(f"window.doomalay.openChatBySession({json.dumps(sid)},{{}}); window.__curChat={json.dumps(marker)};")
            page.wait_for_timeout(1300)

        def send(text):
            js("""(t => { const ta = document.querySelector('#chat-input'); if (!ta) return 'NO COMPOSER';
              ta.value = t; ta.dispatchEvent(new Event('input',{bubbles:true}));
              document.querySelector('#chat-send').click(); return 'sent'; })""" + f"({json.dumps(text)})")

        def pill():
            return js("""(() => { const r = document.querySelector('.chat-working');
              return r ? r.querySelector('.cwt').textContent : '(none)'; })()""")

        def wait_terminal(sid, secs=60):
            for _ in range(secs * 2):
                ev = api(f"/api/sessions/{sid}/events?limit=200")
                lst = ev.get("events") or []
                if any(e.get("type") == "status" and e.get("state") in ("idle", "error") for e in lst[-6:]):
                    return lst
                time.sleep(0.5)
            return api(f"/api/sessions/{sid}/events?limit=200").get("events") or []

        print("RA — THE HONEST NET (engine arm, the user's device shape)")
        open_chat(sid_nv, "nv")
        send("Reply with exactly: NV-OK")
        nv_ev = wait_terminal(sid_nv, 90)
        nv_ok = any("NV-OK" in str(e.get("text") or e.get("message") or "") for e in nv_ev)
        check("RA1 the real Nvidia turn completed (health evidence)", nv_ok)

        open_chat(sid_pm, "pm")
        send("hello pm please reply")
        pm_ev = wait_terminal(sid_pm, 60)
        pm_texts = [f"{e['type']}: {str(e.get('message') or e.get('text') or '')[:120]}"
                    for e in pm_ev if e.get("type") in ("progress", "status", "notice", "error")]
        check("RA2 the PM texts NEVER blame the network", not any("network" in t.lower() for t in pm_texts), " | ".join(pm_texts[-4:]))
        check("RA3 the texts name PrivateMode", any("PrivateMode" in t for t in pm_texts))
        # v1.45.5: the hiccup texts are LIVE-WIRE truth (the persisted
        # status rows store only {"state":"running"}); the counter is
        # asserted on the wire itself — an in-page WS turn on a fresh PM
        # session collects every status/progress text the pills feed from.
        wire_texts = js("""(async () => {
          const sid = await fetch('/api/sessions', {method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({title:'WireProbe', sandbox:'quick', provider:'privatemodeai',
              model:'privatemodeai/glm-5.3-flash'})}).then(r => r.json()).then(d => d.ID);
          return new Promise(resolve => {
            const ws = new WebSocket('ws://127.0.0.1:%d/api/chat?session_id=' + sid);
            const out = [];
            ws.onopen = () => ws.send(JSON.stringify({session_id: sid, type: 'send', message: 'counter probe'}));
            ws.onmessage = ev => { try { const m = JSON.parse(ev.data);
              const blob = String(m.message || m.text || '');
              if (blob) out.push(blob); } catch (e) {} };
            setTimeout(() => { ws.close(); resolve(JSON.stringify(out)); }, 14000);
          });
        })()""" % PORT)
        wt = json.loads(wire_texts or "[]")
        check("RA4 the true counter on the wire (retry N/QUICK, never the hardcoded /2)",
              any("retry 1/5" in t for t in wt) and any("retry 5/5" in t for t in wt)
              and not any("retry " in t and "/2" in t for t in wt),
              " | ".join([t for t in wt if "retry" in t][:4]))
        bubble = js("""(() => { const rows = [...document.querySelectorAll('#chat-messages > *')];
          const last = rows[rows.length - 1]; return last ? last.textContent.slice(0, 220) : ''; })()""")
        check("RA5 the honest bounded terminal (the transcript's error bubble)",
              "PrivateMode is unreachable right now" in str(bubble) and "your connection is fine" in str(bubble), str(bubble)[:160])
        open_chat(sid_pm, "pm2")
        send("try again")
        page.wait_for_timeout(2000)
        ev2 = api(f"/api/sessions/{sid_pm}/events?limit=200").get("events") or []
        check("RA6 the session lock RELEASED (the fresh send is not busy)",
              not any("busy" in str(e.get("message") or e.get("text") or "") for e in ev2[-4:]))
        browser_pill = pill()
        check("RA7 the pill shows the honest provider text", ("PrivateMode" in browser_pill or browser_pill == "(none)"), browser_pill)

        print("RB — THE PILL OBJECTS (rapid switching, zero cross-chat texts)")
        if sid_or:
            open_chat(sid_or, "or")
            send("say OR-OK")
            page.wait_for_timeout(4000)
        for r in range(3):
            open_chat(sid_pm, "chat-PM");   p1 = pill()
            open_chat(sid_nv, "chat-NV");   p2 = pill()
            check(f"RB{r}a PM chat shows only PM/neutral pill text", "Nvidia" not in p1, p1)
            check(f"RB{r}b NV chat shows only NV/neutral pill text", "PrivateMode" not in p2, p2)
            if sid_or:
                open_chat(sid_or, "chat-OR"); p3 = pill()
                check(f"RB{r}c OR chat clean", "PrivateMode" not in p3 and "Nvidia" not in p3, p3)
        log = js("JSON.stringify(window.__pillLog)")
        entries = json.loads(log) if log else []
        bad = [e for e in entries
               if ("PrivateMode" in e["x"] and "PM" not in e["c"] and "pm" not in e["c"])
               or ("Nvidia" in e["x"] and e["c"] not in ("chat-NV", "nv"))
               or ("OpenRouter" in e["x"] and e["c"] not in ("chat-OR", "or"))]
        check(f"RB-final the MutationObserver log is cross-chat clean ({len(entries)} samples)", not bad,
              json.dumps(bad[:3]) if bad else "")

        print("RC — THE STASH PATH (panel close → reopen, no stale flash)")
        # a GUARANTEED-LIVE turn on a FRESH session (the RA turns' ladders
        # still hold their sessions' locks — a busy reject would fake a
        # missing pill): a fresh PM send is mid-ladder for ~9-13s (5 rungs
        # ≈ 5s + the 4s hold); the close+reopen window is ~2.5s — the pill
        # must survive it with the CURRENT phase text. (A turn that ENDED
        # while closed honestly shows no pill — not this arm.)
        sid_stash = api("/api/sessions", {"title": "StashRig", "sandbox": "quick",
            "provider": "privatemodeai", "model": "privatemodeai/glm-5.3-flash"})["ID"]
        open_chat(sid_stash, "chat-PM")
        send("stash probe")
        page.wait_for_timeout(3000)   # mid-ladder
        before = pill()
        js("document.dispatchEvent(new CustomEvent('doomalay:panel-closed'));")
        page.wait_for_timeout(1100)
        open_chat(sid_stash, "chat-PM")
        after = pill()
        check("RC1 the live pill re-binds on reopen (row present)",
              after != "(none)" and "PrivateMode" in after, f"before={before} after={after}")
        check("RC2 no stale flash (the text is the CURRENT live phase)",
              ("PrivateMode" in after) and ("unreachable" in after or "hiccup" in after or "pacing" in after),
              f"before={before} after={after}")

        print("RD — THE QUIET ORACLE (zero auto-wasm)")
        reqlog.clear()
        open_chat(sid_pm, "chat-PM")
        page.wait_for_timeout(2500)
        pm_reqs = [u for u in reqlog if ("vendor/pm" in u or "wasm" in u or "attest" in u or "handshake-ticket" in u)]
        check(f"RD1 PM chat open fires ZERO pm/wasm/attest/ticket requests ({len(reqlog)} total)", not pm_reqs,
              " | ".join(pm_reqs[:3]))

        browser.close()

    print("RE — THE SOURCE PINS")
    def read(p): return open(os.path.join(ROOT, p)).read()
    pmstate = read("engine/internal/pmstate/pmstate.go")
    provenance = read("engine/internal/pm/PROVENANCE.md")
    chatgo = read("engine/internal/llm/chat.go")
    panel = read("engine/internal/server/web/chatpanel.js")
    check("RE1 pmstate dials via netx (the Android wire)", "netx.Transport()" in pmstate)
    check("RE2 PROVENANCE delta 8 records the transport divergence", "Delta 8" in provenance and "netx" in provenance)
    check("RE3 the honest provider-scoped texts exist", "is unreachable — retrying in" in chatgo and "your connection is fine" in chatgo)
    check("RE4 the bounded hold knob exists", "DOOMALAY_PROVIDER_HOLD_MS" in chatgo)
    check("RE5 ZERO auto-wasm in the chat UI", "pmOracleNudge" not in panel and "rerunOracle" not in panel)
    check("RE6 the ActivityPill object exists (one instance per chat)", "ActivityPill" in panel and "state._pill.bind" in panel)
finally:
    try: proc.kill()
    except Exception: pass
    time.sleep(0.3)
    shutil.rmtree(data, ignore_errors=True)

print("\n" + "═" * 44)
print(f"{'PASS' if fail_n == 0 else 'FAIL'} {ok_n}/{ok_n + fail_n} — THE HONEST PM battery")
sys.exit(0 if fail_n == 0 else 1)
