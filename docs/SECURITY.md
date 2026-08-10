# Security — Doomalay Engine

This document is the security threat model + mitigations for the self-hosted
Doomalay engine. Read it before exposing the engine beyond localhost.

## TL;DR

- **Default is safe**: the engine binds to `127.0.0.1` (localhost only). No
  other device on your network can reach it. Your chats and API keys never
  leave your machine.
- **If you expose it to LAN/remote** (`bind: 0.0.0.0` in config), you MUST
  set `auth_token` — otherwise anyone on your network can read your chats
  and keys.
- **API keys are encrypted at rest** (AES-256-GCM). The master key is a
  random 32-byte file at `~/.local/share/doomalay/master.key` (mode 0600).
- **Chat data is plaintext at rest** in SQLite (mode 0600). The user owns
  the disk. For full at-rest encryption, a future phase can use SQLCipher.
- **No telemetry. No phone-home. No analytics.** The engine never sends
  anything anywhere. All network traffic is between you and your chosen LLM
  provider (OpenRouter/NVIDIA/etc.) — and only when you send a chat message.

## Threat Model

### What we protect
1. **Provider API keys** (OpenRouter, OpenAI, etc.) — if leaked, someone can
   spend your credits.
2. **Chat transcripts** — your conversations may contain sensitive info.
3. **Workspace files** — code/repos you clone into the sandbox.
4. **The engine itself** — if hijacked, an attacker could run arbitrary code
   on your machine (the engine has a shell tool, Phase 2b).

### Attack surfaces + mitigations

| Attack | Surface | Mitigation |
|---|---|---|
| **Malicious website reads your chats** | CORS `*` would let any site call `/api/*` | CORS restricted to localhost + `allowed_origins` in config. Unknown origins get `403 origin not allowed`. |
| **Malicious website opens a WebSocket** | WS has no origin check by default | WS upgrade checks the `Origin` header (same rules as CORS). Cross-origin WS is rejected. |
| **Someone on your WiFi reads your traffic** | Engine serves HTTP (not HTTPS) | Default bind is `127.0.0.1` (no network exposure). For LAN access, use a reverse proxy (Caddy) for HTTPS, OR set `auth_token` + accept the HTTP risk on a trusted LAN. |
| **Someone on your WiFi accesses the engine** | Engine bound to `0.0.0.0` with no auth | Engine warns loudly at startup if `bind: 0.0.0.0` + no `auth_token`. The `authMiddleware` rejects all non-localhost requests without a valid bearer token. |
| **Provider keys stolen from disk** | `secrets.json` plaintext on disk | Keys are AES-256-GCM encrypted. The master key is a separate file (`master.key`, 0600). Both files are owner-only readable. |
| **Provider keys in process env** | Brain subprocess has keys in `os.environ` | Keys are injected per-request via `X-Env-*` headers (not persisted to a file). The brain is localhost-only (binds to `127.0.0.1:9090`). No remote access. |
| **Provider keys logged** | Logging middleware might log headers | `loggingMiddleware` logs ONLY method + path. Never headers, never body, never query params. |
| **Chat data stolen from disk** | SQLite DB is plaintext | DB file is mode 0600. Data dir is mode 0700. Only the user can read them. For higher assurance, use full-disk encryption (LUKS/FileVault) — the DB inherits the disk's encryption. |
| **Slowloris DoS** | Engine accepts connections but they hang | `ReadHeaderTimeout: 10s` — slow headers are dropped. `IdleTimeout: 120s` — idle connections are closed. |
| **Provider key allowlist bypass** | User sets an arbitrary env var | `secrets.PROVIDER_KEY_ALLOWLIST` — only provider API key env vars (OPENROUTER_API_KEY, etc.) can be set. Arbitrary env vars are rejected with `400`. |
| **Path traversal in file endpoints** | `GET /api/files?path=../../etc/passwd` | (Phase 2b) File endpoints will validate paths are within the workspace root. Not yet implemented — Phase 2b. |
| **Shell injection in sandbox** | `POST /api/shell/execute` runs arbitrary commands | (Phase 2b) The shell runs inside a bubblewrap sandbox (no host access). The user explicitly enables it per-chat. Not yet implemented — Phase 2b. |

## File permissions (verified)

```
~/.local/share/doomalay/          drwx------  (0700, owner-only)
├── doomalay.db                   -rw-------  (0600, chat data)
├── master.key                    -rw-------  (0600, AES master key)
├── secrets.json                  -rw-------  (0600, encrypted provider keys)
└── workspaces/                   drwx------  (0700, cloned repos)
```

## What is NOT encrypted at rest

- **Chat sessions + events** in `doomalay.db` — plaintext SQLite. Mitigated
  by file perms (0600) + the user owning the disk. For full encryption,
  use SQLCipher (future) or full-disk encryption (now).
- **Workspace files** (cloned repos, generated code) — plaintext on disk.
  These are the user's own files; they're as secure as any other file on
  the user's machine.

## Provider key flow (how keys reach the LLM)

```
User adds key via PWA
  → POST /api/keys (HTTPS if reverse-proxied, else HTTP localhost)
  → Engine: secrets.Vault.Set() → AES-256-GCM encrypt → secrets.json (0600)
  → Engine: vault.AsEnv() → pushes to brain.Brain.SetEnv()

User sends a chat message
  → PWA → WS /api/chat → Engine
  → Engine: brain.Chat() → POST localhost:9090/chat
    → X-Env-OPENROUTER_API_KEY: sk-... (header, localhost only)
  → Brain: os.environ["OPENROUTER_API_KEY"] = "sk-..."
  → Brain: litellm.acompletion(api_key=os.environ[...])
  → LLM provider (OpenRouter/NVIDIA/etc.)
```

Keys NEVER touch the filesystem unencrypted. They transit only:
1. PWA → engine (HTTPS if reverse-proxied, else HTTP localhost)
2. Engine → brain (localhost HTTP, X-Env-* header)
3. Brain → LLM provider (HTTPS, the provider's API)

## If you must expose the engine to LAN/remote

1. Set a strong `auth_token` in `~/.config/doomalay/config.yaml`:
   ```yaml
   bind: 0.0.0.0
   auth_token: "<random 32+ char string>"
   allowed_origins:
     - "https://doomalay.mydomain.com"
   ```
2. Put the engine behind a reverse proxy (Caddy) for HTTPS:
   ```caddyfile
   doomalay.mydomain.com {
     reverse_proxy localhost:8080
   }
   ```
3. The PWA sends `Authorization: Bearer <token>` on every request once you
   configure the token in the engine's settings.

## Reporting a vulnerability

Email the repo owner via GitHub. Do not open a public issue for security bugs.
