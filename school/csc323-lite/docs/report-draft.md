# Report draft (fills the faculty template; ~-markers are the guideline word counts)

> Cover fields left as placeholders on purpose: Student ID / Name / Major.

## Project Description (around 500 words)

Doomalay Lite is a Windows Forms chat application written in C# on .NET 8. It
is the deliberately barebones miniature of our production chatbot "doomalay",
a large multi-component assistant (Go engine, Python brain, web app), rebuilt
here with only the essential conversation core so that every line of code can
be studied, tested and defended at the scale of a course project. The user
types a message, the message joins a persistent conversation history, and an
AI provider returns an answer that is appended to the transcript - a classic
back-and-forth chat with full memory of the dialogue.

The application talks to exactly one provider (OpenRouter) with exactly one
pinned model (recursive/flint-v1.0:free), and it has no tools, no streaming
and no extensions: the smallest honest version of our real product. A second
provider, Echo, never touches the network: it answers with local canned
replies so the application remains fully demonstrable without internet access
or when the free model pool is rate-limited. Switching between the two
providers at runtime through a combo box is deliberate: it is the living
proof that both implementations are substitutable for the same abstraction.

Architecturally the solution is layered in five namespaces. Core holds the
domain: ChatRole (an enum), ChatMessage, the Conversation collection with
automatic history trimming, ApiSettings and the ChatReply result. Providers
holds the abstraction IChatProvider, the information-only interface
IProviderInfo, the abstract class ChatProviderBase that implements a template
Send() method (guard, readiness check, timing, error translation), and the two
concrete providers; OpenRouterProvider additionally adapts OpenRouter's
REST/JSON wire contract (four DTO classes in Providers.Dto) into clean domain
objects, and even ports a "provider quirk" idea from the parent project:
reasoning-style models sometimes answer with empty content while the actual
text sits in a reasoning field, and the adapter degrades gracefully in that
case. Services holds ChatService, a Singleton facade that owns the
conversation and the active provider, exposes four methods to the outside
world, and loads the API key from the environment so no secret ever reaches
source control. UI holds frmChat, a thin form that only paints state and
captures input, plus Program as the entry point.

In total the design contains twenty-one types related in a coherent,
meaningful structure, not demos bolted together. The five SOLID principles
are exercised where they naturally belong: single responsibility across the
layers, open-closed provider extension through the factory, Liskov
substitution proven by the interchangeable providers (and by test stubs),
interface segregation through the split send/info interfaces, and dependency
inversion with the high-level modules depending only on abstractions. Three
GoF patterns from the course catalogue are realized for real features:
Strategy (interchangeable providers), Adapter (REST/JSON world to domain
interface) and Singleton (the single chat brain). A zero-dependency smoke
suite of sixty-five offline tests plus five live API tests protects the
behavior, and the same suite runs on every push in GitHub Actions.

(~495 words)

## Class Diagram (UML)

Figure 1. Doomalay Lite class diagram - 21 types in 5 namespaces; legend:
+ public, - private, # protected, underlined = static; hollow triangle =
inheritance, dashed triangle = interface realization, filled diamond =
composition. (File: docs/diagram/class_diagram.png, editable source in
src/DoomalayLite/DoomalayLite.cd)

## Source Code (C#)

Planned figures (each with caption):
- Figure 2. Core domain: ChatMessage, Conversation, ApiSettings (constructor
  overloading, properties, foreach + StringBuilder, List<T> trimming)
- Figure 3. Abstractions: IChatProvider, IProviderInfo, ChatProviderBase
  (template method, abstract/virtual/override)
- Figure 4. Adapter: OpenRouterProvider with the four DTO classes and the
  reasoning-quirk fallback; EchoProvider with keyword replies
- Figure 5. Singleton facade: ChatService (private ctor, GetInstance, SwitchProvider)
- Figure 6. UI: frmChat event handlers (async send with try/finally busy
  state, graceful degradation to Echo, guarded provider switching)

## Key concepts (around 30 words each)

| Concept | Where and how |
|---|---|
| Abstraction (abstract classes and/or interfaces) | IChatProvider and IProviderInfo are pure contracts; ChatProviderBase is an abstract class implementing the shared Send() template while leaving DoSend() and GetDisplayName() abstract. |
| Concrete classes | ChatMessage, Conversation, EchoProvider, OpenRouterProvider, ChatService and frmChat are instantiable classes with real state and behavior that together form the running chatbot. |
| Namespaces | Code is organized into DoomalayLite.Core, .Providers, .Providers.Dto, .Services and .UI, mirroring the architecture and separating domain, vendors, orchestration and UI. |
| Methods | Conversation.Render() builds the transcript, OpenRouterProvider.Post() performs the HTTP call, ChatService.SendUserMessage() orchestrates a full turn with memory. |
| Properties | ChatMessage.Role/Content/CreatedAt, ApiSettings.ModelName and ChatProviderBase.DisplayName/IsReady use accessors; CreatedAt is read-only over a private DateTime field. |
| Overriding of methods and/or properties | EchoProvider and OpenRouterProvider override abstract DoSend()/GetDisplayName() and virtual ValidateSettings(); ChatMessage and ChatReply override Object.ToString() for the transcript. |
| Constructor overloading | ChatMessage has (string) and (ChatRole, string) constructors; ApiSettings chains three constructors with this(); ProviderException mirrors Exception's two-ctor pattern. |
| Enumeration (Enum) | ChatRole (System/User/Assistant) drives the wire mapping; ProviderKind (OpenRouter/Echo) fills the provider combo box at runtime through Enum.GetValues. |
| Collections (e.g., Lists) | Conversation holds a List<ChatMessage> with automatic trimming; DTOs carry List<RequestMessage> and List<Choice>; the factory returns providers behind ICollection-free minimal surfaces. |
| Loops (e.g., foreach) | foreach iterates messages in Conversation.Render(), maps ChatMessages to wire DTOs in OpenRouterProvider.MapMessages(), fills the combo box in frmChat, counts words in EchoProvider. |

## SOLID principles (around 50 words each)

| Principle | Where realized and for what purpose |
|---|---|
| 1) Single Responsibility | Each type has one reason to change: frmChat only paints and captures input, ChatService only orchestrates turns, OpenRouterProvider only speaks HTTP/JSON, Conversation only manages history; UI, orchestration and API changes never collide. |
| 2) Open-Closed | Adding a provider (e.g., Mistral) means one new ChatProviderBase subclass and one factory case; ChatService, frmChat and all other classes stay untouched - the system grows by extension, not modification. |
| 3) Liskov Substitution | EchoProvider and OpenRouterProvider are fully substitutable behind IChatProvider: the form, service and smoke tests send through one abstraction without knowing which concrete provider answers; the runtime combo box demonstrates substitution live. |
| 4) Interface Segregation | Clients see only what they use: ChatService depends on the minimal IChatProvider (Send), while the status bar consumes the separate IProviderInfo (DisplayName/IsReady); no consumer drags members it never calls. |
| 5) Dependency Inversion | High-level modules (ChatService, frmChat) depend on the abstractions IChatProvider/IProviderInfo, never on concrete providers; ProviderFactory injects the concrete at a single composition point. |

## GOF design patterns (around 50 words each)

| Pattern | Where realized and for what purpose |
|---|---|
| 1) Strategy | IChatProvider encapsulates the "how to answer" algorithm; OpenRouterProvider (live API) and EchoProvider (offline canned replies) are interchangeable strategies that ChatService can hot-swap at runtime. |
| 2) Adapter | OpenRouterProvider converts OpenRouter's REST/JSON world (ChatCompletionRequest/Response DTOs, headers, status codes, quirks) into our domain interface IChatProvider over clean ChatMessage/ChatReply objects. |
| 3) Singleton | ChatService uses a private constructor, static _instance and thread-safe GetInstance() so exactly one chat brain exists per application; the form reaches it through one global access point. |

## User Interface (Windows Forms)

Figure 7. Doomalay Lite main window: provider combo (OpenRouter / Echo),
read-only transcript, input box with Send (or Enter), New chat button, status
bar showing the active provider and pinned model - or the offline fallback hint.

Brief description (around 50 words): The single form hosts a provider combo
box, a read-only transcript, a multiline input with Send/Enter and a New chat
button; a status strip reports provider readiness. Without an API key the app
auto-selects the offline Echo provider, so the demo always works.

## Submission checklist (Blackboard)

- [ ] Report .docx from the faculty template (this draft formatted in)
- [ ] Class diagram file: src/DoomalayLite/DoomalayLite.cd (StarUML/VS requirement)
- [ ] Visual Studio solution + project: school/csc323-lite (zip DoomalayLite.sln tree)
- [ ] One zip, submitted through Blackboard before the deadline
