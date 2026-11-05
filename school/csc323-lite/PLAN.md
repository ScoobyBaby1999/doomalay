# DCLbot - CSC 323 Project Blueprint (approved)

> Formerly **Doomalay Lite** - renamed to DCLbot in v0.8.0.

A barebones, single-provider, single-model Windows Forms chatbot in C# (.NET 8):
the course-materials-native **miniature architectural mirror** of the doomalay
production chatbot (Go engine + Python brain + PWA). Same architecture ideas -
provider abstraction, one vendor adapter, health/echo fallback, chat facade -
expressed in the C# OOP vocabulary of CSC 323 (Chapters 1-5).

## Scope (the barebones cut line)

- ONE provider (OpenRouter), ONE pinned model (`recursive/flint-v1.0:free`)
- Offline **Echo** provider twin (demo never dies on Wi-Fi / free-tier 429s)
- Full conversation memory (List&lt;ChatMessage&gt; sent every turn)
- No tools, no streaming, no MCP, no jobs, no persistence, no auth

## The 20 types (minimum was 15)

| # | Type | Kind | Purpose |
|---|------|------|---------|
| 1 | `ChatRole` | enum | System, User, Assistant |
| 2 | `ChatMessage` | class | role + content + timestamp; ctor overloading; ToString override |
| 3 | `Conversation` | class | List<ChatMessage>; Add/Trim/Render (foreach + StringBuilder) |
| 4 | `ApiSettings` | class | endpoint/model/key/timeout/system prompt; 3 chained ctors |
| 5 | `ChatReply` | class | domain result: content, model, elapsed seconds |
| 6 | `IChatProvider` | interface | Send(messages) : ChatReply - ISP-kept-small |
| 7 | `IProviderInfo` | interface | DisplayName, IsReady - UI status only (ISP split) |
| 8 | `ChatProviderBase` | abstract class | template method: guard + stopwatch + error wrapping |
| 9 | `OpenRouterProvider` | concrete | HTTP+JSON adapter, header Dictionary, quirk handling |
| 10 | `EchoProvider` | concrete | offline mock twin (LSP proof) |
| 11 | `ProviderKind` | enum | OpenRouter, Echo |
| 12 | `ProviderFactory` | class | Create(kind, settings) - single composition point |
| 13 | `ProviderException` | class | domain exception (inherits Exception, 2 ctors) |
| 14-17 | `ChatCompletionRequest`, `RequestMessage`, `ChatCompletionResponse`, `Choice` | DTOs | OpenRouter wire contract, isolated in .Providers.Dto |
| 18 | `ChatService` | class (Singleton) | facade: owns Conversation + provider; SendUserMessage / SwitchProvider / Reset |
| 19 | `frmChat` | Form | thin UI: input, send, transcript, provider combo, status |
| 20 | `Program` | class | entry point / composition root |

## SOLID (all five) and GOF (three)

- **S**RP: form paints / service orchestrates / adapter speaks HTTP
- **O**CP: new provider = one subclass + factory entry; nothing else changes
- **L**SP: Echo and OpenRouter interchangeable behind IChatProvider (runtime combo = live proof)
- **I**SP: IChatProvider (send) vs IProviderInfo (status) split
- **D**IP: high-level modules depend on abstractions; concrete wired once

Patterns (course Ch.5 selection): **Strategy** (interchangeable providers),
**Adapter** (REST/DTO world -> domain IChatProvider), **Singleton**
(ChatService.GetInstance). ChatService additionally acts as a **Facade**.

## Versioned phase plan (every push updates docs/class-diagram.png)

| Version | Content |
|---------|---------|
| v0.1.0 | scaffold: solution, WinForms project, PLAN, CI workflow |
| v0.2.0 | Core package + offline smoke tests |
| v0.3.0 | Provider abstraction (interfaces, base, Echo, factory, exception) |
| v0.4.0 | OpenRouterProvider + DTOs + live API test |
| v0.5.0 | ChatService singleton facade |
| v0.6.0 | full frmChat UI + Program |
| v0.7.0 | VS .cd class diagram, rendered UML PNG, README, report draft |
| v0.7.1 | THE BUSY-STATE FIX: the `_busy` flag was set on the first send and NEVER cleared ("only one message per app run" - even New chat could not send again); SetBusy() now owns flag + visuals atomically, whole send turn in try/finally, input uses ReadOnly (focus-safe), Enter routed via AcceptsReturn+KeyDown, leaked revoked key purged from ApiSettings, class diagram regenerated (static underline notation + missing members) |
| v0.8.0 | THE RENAME + THE REMAINING TWO FIXES: project renamed **DoomalayLite -> DCLbot** (solution, projects, folders, namespaces, .cd, CI, docs); (1) combo never hijacks back to Echo (selection is final, readiness paints the status bar, actionable 401/402 guidance, blank env key = "no override" not "wipe"); (2) `Application.ThreadException` net keeps the app alive on unexpected UI-thread exceptions; (3) OpenRouter tested live - adapter proven through a foreign OpenAI-compatible endpoint (`LIVE_WIRE_*`), verdict: the v0.7.0 key was dead (401 User not found), the wire path itself is correct. Smoke suite 72 offline (+7 regression pins) + live wire proof |
| v0.9.0 | THE CODE-DERIVED CLASS DIAGRAM: hand-maintained spec + curved graphviz edges replaced by generate_diagram.py parsing the C# sources (21 types, 36 edges) rendered with PlantUML - arrows can no longer be inverted or dangle; fixes the two review defects (ChatService "send" now visibly reaches the IChatProvider box; the phantom "ApiSettings is the model kind" routing is impossible - only frmChat uses / ChatService switches on / ProviderFactory reads ProviderKind), corrects Main() signature, keeps course notation (+/-/#, static underline, stereotypes, verb labels, multiplicities); .puml + .cd both committed as editable sources; behavior unchanged, 72/72 green |

## Testing discipline

- Offline smoke suite runs every build (core, providers, JSON wire shape)
- Live suite (needs OPENROUTER_API_KEY env var) runs on demand: Arabic text,
  emoji, long input, wrong key, empty-content quirk (reasoning-only models)
- Live wire proof: `LIVE_WIRE_URL` / `LIVE_WIRE_KEY` / `LIVE_WIRE_MODEL` env
  vars point the SAME adapter at any OpenAI-compatible endpoint
- The built-in key is a replaceable convenience default; the env var always wins
- Before every push: fetch -> rebase onto origin/csc323-project -> build -> secret scan -> push
