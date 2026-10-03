import asyncio, sys
sys.path.insert(0, '/tmp/bugbrain/brain')
import litellm

async def main():
    # the _run_litellm_direct fallback + the nudge rounds use acompletion
    stream = await litellm.acompletion(model="openai/z-ai/glm-5.3-flash",
        messages=[{"role":"user","content":"hi"}], api_key="mock_key",
        base_url="http://127.0.0.1:8542/v1", stream=True, timeout=60)
    got_reasoning = False
    async for ch in stream:
        d = getattr(getattr(ch.choices[0], "delta", None) if ch.choices else None, "reasoning_content", None)
        c = getattr(getattr(ch.choices[0], "delta", None) if ch.choices else None, "content", None)
        if d: got_reasoning = True
        if d or c: print("reasoning:", repr(d), "content:", repr(c))
        if ch.choices and ch.choices[0].finish_reason: break
    print("ACOMPLETION reasoning survives:", got_reasoning)

asyncio.run(main())
