import sys
sys.path.insert(0, '/tmp/bugbrain/brain')
import litellm

import importlib.metadata as md; print("litellm", md.version("litellm"))
client = litellm.LiteLLM(api_key="mock_key", base_url="http://127.0.0.1:8541/v1", timeout=60, max_retries=0)
resp = client.chat.completions.create(model="openai/z-ai/glm-5.3-flash", messages=[{"role":"user","content":"hi"}], stream=True)
for ev in resp:
    ch = ev.choices[0] if getattr(ev, "choices", None) else None
    d = getattr(ch, "delta", None) if ch else None
    if d is None:
        continue
    print("DELTA raw:", repr(d), "| reasoning_content:", repr(getattr(d, "reasoning_content", None)), "| reasoning:", repr(getattr(d, "reasoning", None)), "| content:", repr(getattr(d, "content", None)))
    if getattr(ch, "finish_reason", None):
        break
