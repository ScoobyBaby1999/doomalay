#!/usr/bin/env bash
# v0894-hf-turn-2.sh — the CORRECT HF final-test turn: sandbox=hf via
# ctx.applySandbox (arms the engine→space relay) + an NVIDIA model (non-PM
# so the UI routes through the engine WS, not the local PM bridge).
set -u
cd "$(dirname "$0")/.."
BASE=http://127.0.0.1:8489
export AGENT_BROWSER_SESSION=doomalay-v0894

ev() { agent-browser eval "$1" 2>/dev/null | python3 -c "
import sys, json
lines = sys.stdin.read().split('\n')
out = ''
for ln in lines:
    ln = ln.strip()
    if not ln: continue
    try:
        v = json.loads(ln)
        if isinstance(v, dict): v = v.get('data',{}).get('result', v)
        if isinstance(v, list) and len(v) == 1: v = v[0]
        out = v
    except Exception:
        pass
print(out, end='')"; }

agent-browser close >/dev/null 2>&1; sleep 0.6
agent-browser open "$BASE" >/dev/null 2>&1
for i in 1 2 3 4 5 6 8; do V=$(agent-browser eval "document.readyState" 2>/dev/null | tr -d '"\n'); [ "$V" = "complete" ] && break; sleep 0.8; done
ev "localStorage.clear()" >/dev/null 2>&1

R=$(ev "(async function(){
  for (var i=0;i<30 && !document.getElementById('dock-sub');i++) await new Promise(r=>setTimeout(r,300));
  document.getElementById('canvas-empty-btn').click();
  await new Promise(r => setTimeout(r, 1200));
  var c = window.ChatPanel.current(); var cx = c && (c.ctx || c);
  if (!cx || !cx.applySandbox) return 'NO-CTX';
  // THE PROPER FLOW: the sandbox picker's own-space path
  cx.applySandbox('hf', {mode: 'own', repo: 'ScoobyBaby1999/doomalay-final-test'});
  await new Promise(r => setTimeout(r, 900));
  cx.applyModel('nvidia', 'nvidia/deepseek-ai/deepseek-v4.1-flash');
  await new Promise(r => setTimeout(r, 2500));
  var st = window.ChatPanel.current().state;
  var ok = st.sandbox === 'hf' && st.sandboxMode === 'own' && st.model === 'nvidia/deepseek-ai/deepseek-v4.1-flash';
  var inp = document.getElementById('chat-input');
  if (!ok || !inp) return JSON.stringify({fail: 'setup', sandbox: st.sandbox, mode: st.sandboxMode, model: st.model});
  inp.value = 'FINAL CAPABILITY TEST. Do these in order, showing real outputs: (1) Read HARNESS.md in your workspace (cat HARNESS.md) and list what you can do. (2) Prove the sandbox: run uname -a, df -h /data, python3 --version, and install a pip package (e.g. rich) showing it works. (3) Write and run a small Python simulation (e.g. bouncing balls) that outputs a summary; attach the script as an artifact. (4) STORAGE TEST: generate data files until at least 5GB is used (show df/du before and after), then delete them and show the space is healthy again. (5) THE GAME: build an evolution simulator as a single self-contained index.html written to your public root so it serves at /pub/ — three spawnable colored dot species on a canvas: GREEN never dies; BLUE must eat a GREEN dot within 20 seconds or it dies; RED must eat a BLUE dot within 20 seconds or it dies. Every dot only ever flees or chases (predators chase prey, prey flee predators). Buttons to spawn each type + reset, live population counters, and a visible starvation countdown ring on each hungry dot. Keep it beautiful and smooth. When done, reply with the exact /pub/ URL.';
  inp.dispatchEvent(new Event('input', {bubbles:true}));
  var snd = document.getElementById('chat-send');
  if (!snd) return 'NO-SEND';
  snd.click();
  return JSON.stringify({sent: true, sandbox: st.sandbox, mode: st.sandboxMode, repo: st.sandboxRepo, model: st.model});
})()")
echo "result: $R"
