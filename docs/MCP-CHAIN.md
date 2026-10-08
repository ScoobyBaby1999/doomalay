# THE MCP CHAIN — exposing pre-made community tools to the app's bots

v1.13.4 THE CHAIN (PLAN-V113 §4) made the engine an MCP **aggregator**: any
MCP server — community pre-mades, your own, remote hosts — chains onto the
mcpbus with one calling convention, and `/mcp` serves the merged registry to
every external consumer (the PM browser bridge, bots, other engines).

v1.14.3 THE PRE-MADE HORDE live-proved it with REAL community servers and a
REAL provider turn: `scripts/v1143-community-chain-test.mjs` (23/23).

## How to chain servers

Two config paths (the env var wins):

**1. `<data-dir>/mcp_servers.json`** — persistent, per install:

```json
[
  {
    "name": "fs",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/you/workspace"]
  },
  {
    "name": "memory",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-memory"]
  },
  {
    "name": "sqlite",
    "command": "npx",
    "args": ["-y", "mcp-server-sqlite-npx", "/path/to/db.sqlite"]
  },
  {
    "name": "remote",
    "url": "https://your-host.example/mcp",
    "headers": { "Authorization": "Bearer ..." },
    "timeout_ms": 6000
  }
]
```

**2. `DOOMALAY_MCP_SERVERS`** — the same JSON as an env var (mirrors,
CI rigs, one-off demos).

Each server attaches at boot: initialize → `tools/list` (pagination
auto-followed) → every tool proxied onto the bus as `<name>_<tool>`
(e.g. `fs_write_file`, `memory_create_entities`, `sqlite_write_query`).
Collisions with existing tools are skipped + logged; a bad server never
blocks the chain (`mcpbus: chain attach "x" failed: …` in the engine log).

## What the model sees

Nothing new to learn: the merged manifest (internal 28 + every chained
server) rides the native `tools[]` field like any other tool; the chat loop
executes `fs_read_text_file` exactly like `calculator` — same bus, same
pills, same observers (the tiktoken/OTel sockets see community calls too).
The v1.14.3 receipts: nemotron-3.5-lightning wrote + read back a file,
built + queried a knowledge graph, and created + selected from a SQL table
— all through chained community servers, all grounded in the tool results.

## What apps + bots see

`POST /mcp` (stateless streamable HTTP, JSON-RPC):

```bash
curl -X POST http://127.0.0.1:8580/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'

curl -X POST http://127.0.0.1:8580/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call",
       "params":{"name":"fs_read_text_file","arguments":{"path":"notes.txt"}}}'
```

Session-scoped access (session tools, artifact sinks): add the
`X-Doomalay-Session: <session-id>` header — the PM browser loop does
exactly this.

## Platform notes

- **Android**: stdio subprocesses are skipped (Android restricts `exec`)
  — chain streamable-HTTP remotes there (`url` entries work everywhere;
  `DOOMALAY_MCP_ALLOW_STDIO=1` forces stdio if your build allows it).
- **npx cold start**: the first `npx -y <pkg>` downloads the package
  (~10-30s) — longer than the 30s attach budget. Pre-warm the cache
  (`timeout 8 npx -y <pkg> <args> </dev/null`) or install the server
  globally and point `command` at the binary.
- **Scale**: the attach path auto-paginates `tools/list` — the v1.13.4
  test chained a 100-tool server (120-spec manifest) and v1.13.6's
  `engine/cmd/mcpdemo` is a permanent chain-verification artifact
  (`go run ./cmd/mcpdemo --port 8600 --tools 100`).
- **Verified community servers** (2026-10-08): filesystem
  (14 tools), memory (9), sequential-thinking (1), sqlite-npx (5).
  `server-fetch` and `server-git` are archived (npm 404).

## Security posture

- stdio servers run as engine child processes with the engine's env —
  chain only servers you trust (the filesystem server is rooted to the
  directory you pass it).
- HTTP remotes get your `headers` — treat the header set like a credential.
- `/mcp` is bound to the engine's interface and serves the GLOBAL tool set;
  session tools honestly refuse without `X-Doomalay-Session`.
