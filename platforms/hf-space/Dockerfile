# Doomalay HF Space — the App-Building Machine
#
# A pure-backend Docker container with a full build toolchain + the Strands
# SDK + the Go engine. Can compile web/mobile/Python/Go/Rust apps. The user's
# PWA connects to this Space's URL and all computation happens here.
#
# Limits (HF free tier): 16GB RAM, 2 CPU, 50GB ephemeral disk, sleeps after 48h.
# Can't do: UE5/AAA games (needs 32GB+ RAM + GPU), KVM VMs, docker-in-docker.

FROM python:3.11-slim

# ── Full build toolchain ──────────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential gcc g++ make cmake git ripgrep \
    nodejs npm python3-pip golang-go rustc cargo \
    openjdk-17-jdk-headless \
    qemu-system-x86 qemu-utils \
    bubblewrap ca-certificates curl wget unzip \
    && rm -rf /var/lib/apt/lists/*

# Recent Node via nvm (Debian's nodejs is too old for modern build tools)
RUN curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash \
    && . ~/.nvm/nvm.sh && nvm install 20 && nvm alias default 20

# ── Python brain deps (full FastAPI + Strands — C extensions OK in Docker) ──
WORKDIR /app
COPY brain/requirements.txt /app/brain/requirements.txt
RUN cd /app/brain && pip install --no-cache-dir -r requirements.txt

# ── Go engine (built in CI for linux/amd64) ──
# The engine binary is copied here by the CI workflow.
# Build context = repo root (docker build -f platforms/hf-space/Dockerfile .)
COPY platforms/hf-space/engine/doomalay-engine /app/doomalay-engine
RUN chmod +x /app/doomalay-engine

# ── Brain source ──
COPY brain/ /app/brain/

# ── PWA (built in CI, embedded in the Go binary via //go:embed) ──
# The PWA is already embedded in the Go binary — no separate copy needed.

# ── Persistent workspace (HF persistent /data) ──
VOLUME ["/data/workspaces"]
ENV DOOMALAY_DATA_DIR=/data
ENV MODE=hf-space
ENV BRAIN_DIR=/app/brain

EXPOSE 8080

# The Go engine serves the PWA + proxies to the Python brain.
CMD ["/app/doomalay-engine", "--port", "8080", "--bind", "0.0.0.0"]
