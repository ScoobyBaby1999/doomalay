# DOOMALAY LITE - CSC 323 Project Blueprint (approved)

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

## Testing discipline

- Offline smoke suite runs every build (core, providers, JSON wire shape)
- Live suite (needs OPENROUTER_API_KEY env var) runs on demand: Arabic text,
  emoji, long input, wrong key, empty-content quirk (reasoning-only models)
- Keys NEVER enter git: app reads `OPENROUTER_API_KEY` env var
- Before every push: fetch -> rebase onto origin/main -> build -> secret scan -> push
