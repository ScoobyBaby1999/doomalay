# PLAN — v0.75 "BYOK hardening" (PROPOSED — awaiting the user's go)

Status: PLANNED, NOT BUILT. Per the standing rule: hypothesis → web research
(done, RESEARCH-V075-BYOK-SECURITY.md) → this plan → build → red-team.
Each phase below is independently shippable (x.x.1 … x.x.n), gates included.

## Phase 1 (v0.75.1) — key-in-flight minimization (THE structural fix)

Problem: remote.go applyAuth loops the WHOLE env map → every request to a
third-party Space carries EVERY provider key the user has. One intercepted
request = the full key set.

Fix: per-turn scoping — the engine already knows the turn's provider (the
model resolution). Send ONLY: the resolved provider's env var (+ its EXTRA
field when present, e.g. cloudflare account) + DOOMALAY_HF_TOKEN (aliased
HF_TOKEN). /models keeps the presence-only fan-out (it needs to show which
providers are usable — but see Phase 1b: consider a presence-shape header
that doesn't carry values).

Files: engine/internal/brain/remote.go (Chat: filter rb.env by the request's
provider), engine/internal/server/chat.go (thread the turn's env_var into the
brainReq), tests: mock space asserting the header set exactly.

Gates: unit test (header set == {provider key, extra?, HF tokens}); live rig
proof (mock space echoes which X-Env-* arrived); no behavior change for
own-mode spaces (full vault stays).

## Phase 2 (v0.75.2) — BYOK UX truth (error attribution + privacy wording)

- The chat's provider-error surface gains a BYOK prefix when the turn rode
  the user's key: "your key was rejected (403 at NVIDIA)" vs "the community
  key is unavailable" — engine marks the brainReq with key_source: user|shared;
  the error event carries it; chatpanel renders the distinction.
- Age card + Connected Accounts wording: BYOK = "your key, your bill"; add the
  data-privacy truth: "the community Space still processes your chat — keep
  secrets and personal info out of it."
- Free-tier key confusion: the OpenCode FreeTierError class gets a mapped
  hint ("this provider restricts some keys to its own app — try another
  provider").

Files: brain (key_source in the error event), engine chat.go (plumb it),
chatpanel.js, sandboxpicker.js card note, appearance.js row subs.

Gates: rig test — bogus key → the chat shows the BYOK-attributed error shape;
no console regressions; theme twins/uikit.

## Phase 3 (v0.75.3) — shared-disk isolation audit + fixes (red-team first)

Red-team the community Space's multi-user surfaces as a real second user:
- Two sessions (curl, distinct session_ids): attempt cross-session workspace
  reads, transcript reads, memory/journal reads, env echo.
- Verify the brain's /data|/tmp scoping actually can't traverse (../ paths,
  absolute paths, symlinks).
- Fix whatever the red-team finds in the brain's workspace scoping; add a
  brain-side test locking it.

Gates: brain tests for every traversal vector attempted; live two-session
proof on the community Space (or a local twin).

## Phase 4 (v0.75.4) — in-flight redaction everywhere (log hygiene)

Grep every logging + event-persistence path (brain log_event, server.py error
events, engine chat_events persistence, the engine's own logs) for X-Env
values / Authorization headers / key echoes. Add a redaction helper (prefix
match against the vault values + sk-/nvapi-/hf_ shapes) applied at the sink.
Test: a turn with a bogus key logs redacted forms only.

Gates: unit test with sentinel keys through every sink; rig log inspection.

## Phase 5 (v0.75.5, exploratory) — ephemeral credentials research note

Providers don't offer per-turn tokens; document the future path (OAuth'd
provider delegation where available — OpenRouter's provider OAuth experiments
are the one to watch). NO build unless a provider ships it.

## Ship discipline

- Each phase: branch-free single wave on main (rebase first — the parallel
  bot may push between phases), tag v0.75.x, release, community-Space sync
  for brain-side changes, worklog entry.
- Red-team each phase as a real user (the rig + the tunnel when it's up)
  before the push.
