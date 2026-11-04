# Doomalay Lite (CSC 323 project)

A barebones, single-provider, single-model Windows Forms chatbot in C# (.NET 8):
the course-materials-native **miniature architectural mirror** of the
[doomalay](https://github.com/ScoobyBaby1999/doomalay) production chatbot
(Go engine + Python brain + PWA). Same architecture ideas - provider
abstraction, one vendor adapter, offline fallback, chat facade - expressed in
the C# OOP vocabulary of CSC 323.

## Run (Visual Studio 2022, .NET 8 desktop)

1. Open `DoomalayLite.sln`.
2. Set `DoomalayLite` as the startup project, press F5.
3. No API key? The app auto-falls back to the offline **Echo** provider so the
   demo always works.

### Enabling the live provider

Set the key in the environment **(never in source control)**:

```powershell
$env:OPENROUTER_API_KEY = "your-key-here"   # current PowerShell session
setx OPENROUTER_API_KEY "your-key-here"    # permanent (new processes only)
```

Then restart the app and pick **OpenRouter** in the combo box.
Pinned model: `recursive/flint-v1.0:free` (free tier, verified live).

## Tests

```powershell
dotnet run --project tests/DoomalayLite.Smoke              # 65 offline tests
$env:OPENROUTER_API_KEY = "..." ; dotnet run --project tests/DoomalayLite.Smoke -- live   # +5 live tests
```

CI: `.github/workflows/csc323-lite-build.yml` builds the solution and runs the
offline suite on `windows-latest` for every push to `csc323-project`.

## Layout

```
DoomalayLite.sln
src/DoomalayLite/            the WinForms application (21 types)
  Core/                      ChatRole, ChatMessage, Conversation, ApiSettings, ChatReply
  Providers/                 IChatProvider, IProviderInfo, ChatProviderBase (abstract),
                             OpenRouterProvider (adapter), EchoProvider (offline twin),
                             ProviderKind, ProviderFactory, ProviderException, TextUtils
  Providers/Dto/             OpenRouter wire contract (4 classes)
  Services/                  ChatService (Singleton + Facade)
  UI/                        frmChat (thin form), Program (entry)
  DoomalayLite.cd            Visual Studio class diagram (open in VS)
tests/DoomalayLite.Smoke/    zero-dependency offline + live smoke suite
docs/diagram/                rendered UML class diagram + generator script
docs/report-draft.md         report wording (fills the faculty template)
PLAN.md                      approved project blueprint
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
