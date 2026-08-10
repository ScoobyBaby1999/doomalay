# Brain (Python AI layer)

The brain is the AI layer: Strands agent runner, LiteLLM provider routing,
template library (Phase 2+), judge panel (Phase 2+).

## Setup

```bash
cd brain
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Run (standalone, for debugging)

```bash
.venv/bin/python server.py --port 9090
```

The Go engine spawns the brain automatically on startup — you usually
don't run it directly. The engine looks for `brain/.venv/bin/python` first,
then falls back to system `python3`.

## Endpoints (localhost only)

- `GET /health` — liveness probe
- `GET /models` — provider catalog + sync status (dynamic)
- `POST /chat` — run one agent turn, streams SSE events back

Provider keys arrive as `X-Env-<ENV_VAR>` headers from the Go engine
(the engine holds them in an AES-256-GCM vault). The brain never reads
keys from disk.
