# DCLbot (CSC 323 project)

> Formerly **Doomalay Lite** - renamed to DCLbot in v0.8.0 (solution, projects,
> namespaces and docs all follow the new name).

A barebones, single-provider, single-model Windows Forms chatbot in C# (.NET 8):
the course-materials-native **miniature architectural mirror** of the
[doomalay](https://github.com/ScoobyBaby1999/doomalay) production chatbot
(Go engine + Python brain + PWA). Same architecture ideas - provider
abstraction, one vendor adapter, offline fallback, chat facade - expressed in
the C# OOP vocabulary of CSC 323.

## Run (Visual Studio 2022, .NET 8 desktop)

1. Open `DCLbot.sln`.
2. Set `DCLbot` as the startup project, press F5.
3. No API key? The combo stays on whatever you pick; the offline **Echo**
   provider keeps the demo alive, and OpenRouter explains exactly what it
   needs (a key) instead of bouncing the selection back.

### Enabling the live provider

Real keys never live in source control (the one that leaked in v0.7.0 was
revoked and purged in v0.7.1). Set the key in the environment:

```powershell
$env:OPENROUTER_API_KEY = "your-key-here"   # current PowerShell session
setx OPENROUTER_API_KEY "your-key-here"    # permanent (new processes only)
```

Then restart the app and pick **OpenRouter** in the combo box.
Pinned model: `recursive/flint-v1.0:free` (free tier, still listed on
OpenRouter as of 2026-11-05). Create fresh keys at
<https://openrouter.ai/keys>.

## Tests

```powershell
dotnet run --project tests/DCLbot.Smoke              # 72 offline tests
$env:OPENROUTER_API_KEY = "..." ; dotnet run --project tests/DCLbot.Smoke -- live   # + live tests
```

The live section also honors `LIVE_WIRE_URL` / `LIVE_WIRE_KEY` /
`LIVE_WIRE_MODEL`: point them at ANY OpenAI-compatible endpoint (NVIDIA
NIM, Mistral, etc.) to prove the adapter while the OpenRouter key is being
replaced.

CI: `.github/workflows/dclbot-build.yml` builds the solution and runs the
offline suite on `windows-latest` for every push to `csc323-project`.

## Layout

```
DCLbot.sln
src/DCLbot/                   the WinForms application (21 types)
  Core/                       ChatRole, ChatMessage, Conversation, ApiSettings, ChatReply
  Providers/                  IChatProvider, IProviderInfo, ChatProviderBase (abstract),
                              OpenRouterProvider (adapter), EchoProvider (offline twin),
                              ProviderKind, ProviderFactory, ProviderException, TextUtils
  Providers/Dto/              OpenRouter wire contract (4 classes)
  Services/                   ChatService (Singleton + Facade)
  UI/                         frmChat (thin form), Program (entry)
  DCLbot.cd                   Visual Studio class diagram (open in VS)
tests/DCLbot.Smoke/           zero-dependency offline + live smoke suite
docs/diagram/                 rendered UML class diagram + generator script
docs/report-draft.md          report wording (fills the faculty template)
PLAN.md                       approved project blueprint
```

## Course mapping (quick reference)

- **SOLID**: SRP (form paints / service orchestrates / adapter speaks HTTP),
  OCP (new provider = 1 subclass + 1 factory case), LSP (Echo and OpenRouter
  substitute behind IChatProvider - the combo box proves it live),
  ISP (IChatProvider vs IProviderInfo split), DIP (high level depends on
  abstractions; factory injects concretes).
- **GoF**: Strategy (interchangeable providers), Adapter (REST/JSON world to
  domain interface), Singleton (ChatService.GetInstance).
- **Key concepts**: abstraction, concrete classes, namespaces, methods,
  properties, overriding, constructor overloading, enums, collections, loops.

## Secrets policy

Keys never enter git. The app reads `OPENROUTER_API_KEY` from the environment;
`.gitignore` blocks local key files; every push is secret-scanned.

## Changelog

- **v0.8.0** - THE RENAME (DoomalayLite -> DCLbot: solution, projects, folders,
  namespaces, class designer file, CI, docs) + the two remaining reported
  issues closed on top of v0.7.1:
  (1) *provider combo bounced back to Echo* - the combo is NEVER hijacked
  anymore: what the user picks stays picked; readiness paints the status bar,
  and a not-ready provider that receives a message answers with a clean,
  actionable `[error]` line (OpenRouter 401/402 errors now say exactly how to
  get a fresh key). Also fixed the companion bug where an unset env var wiped
  the key configuration (blank key argument = "no override").
  (2) *belt-and-braces against "app exits after one message"* - on top of the
  v0.7.1 busy-flag fix, `Program.Main` now installs
  `Application.ThreadException` + `UnhandledExceptionMode.CatchException`, so
  an unexpected UI-thread exception (including async/await continuation
  hiccups) shows a message box and the app KEEPS RUNNING instead of silently
  dying. (3) *OpenRouter tested live*: the adapter is proven end-to-end
  through a foreign OpenAI-compatible endpoint (`LIVE_WIRE_*` env vars,
  75/75 including live wire) - the v0.7.0 key was simply dead (401 "User not
  found"), everything else in the wire path is correct. Smoke suite grown to
  72 offline tests (8 new regression pins).
- **v0.7.1** - fixed the busy-state bug that allowed only ONE message to be
  sent per app run (the `_busy` guard flag was set on the first send and never
  cleared, so every later send - even after "New chat" - was silently ignored).
  The flag now lives inside `SetBusy()` together with the visuals and is
  always cleared in the `finally` block of the send handler. Also hardened:
  the whole send turn runs inside try/finally, the input box uses `ReadOnly`
  instead of `Enabled` while thinking so it never loses keyboard focus, the
  provider combo guards its re-entrancy, and Enter is routed through the
  input box KeyDown (`AcceptsReturn = true`). Removed an accidentally
  committed API key from `ApiSettings` (the key was already compromised and
  revoked - 401). Class diagram regenerated: static members now follow the
  course Ch.2 underline notation, and previously missing members were added
  (`CountWords`, `ReadOptions`/`WriteOptions`, `Reasoning`, `ModelName`,
  designer fields).
