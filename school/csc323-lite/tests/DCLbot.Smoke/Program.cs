using System;
using System.Collections.Generic;
using DCLbot.Core;
using DCLbot.Providers;
using DCLbot.Providers.Dto;
using DCLbot.Services;

namespace DCLbot.Smoke
{
    /// <summary>
    /// Zero-dependency smoke suite. No test framework - a tiny harness only,
    /// so the course project keeps its dependency list clean.
    ///
    ///   dotnet run --project tests/DCLbot.Smoke              (offline)
    ///   dotnet run --project tests/DCLbot.Smoke -- live      (OpenRouter, needs OPENROUTER_API_KEY)
    ///
    /// The live section additionally honors LIVE_WIRE_URL / LIVE_WIRE_KEY /
    /// LIVE_WIRE_MODEL: point them at ANY OpenAI-compatible endpoint to prove
    /// the adapter while the OpenRouter key is being replaced.
    /// </summary>
    internal static class Program
    {
        private static int _passed;
        private static int _failed;

        static int Main(string[] args)
        {
            Console.WriteLine("DCLbot smoke suite");
            Console.WriteLine("==================");
            string mode = (args.Length > 0) ? args[0] : "offline";

            RunCoreTests();
            RunProviderOfflineTests();
            RunJsonWireTests();
            RunServiceTests();
            if (mode == "live")
            {
                RunLiveTests();
            }

            Console.WriteLine();
            Console.WriteLine("RESULT: " + _passed + " passed, " + _failed + " failed");
            return (_failed == 0) ? 0 : 1;
        }

        private static void Check(string name, bool condition)
        {
            if (condition)
            {
                _passed++;
                Console.WriteLine("  [PASS] " + name);
            }
            else
            {
                _failed++;
                Console.WriteLine("  [FAIL] " + name);
            }
        }

        // ------------------------------------------------------------------
        // Core package
        // ------------------------------------------------------------------

        private static void RunCoreTests()
        {
            Console.WriteLine();
            Console.WriteLine("[core] ChatMessage");

            ChatMessage byConvenienceCtor = new ChatMessage("hello");
            Check("convenience ctor defaults role to User", byConvenienceCtor.Role == ChatRole.User);
            Check("convenience ctor keeps content", byConvenienceCtor.Content == "hello");

            ChatMessage byFullCtor = new ChatMessage(ChatRole.System, "be brief");
            Check("full ctor stores role", byFullCtor.Role == ChatRole.System);
            Check("full ctor stores content", byFullCtor.Content == "be brief");
            Check("CreatedAt is set to now", (DateTime.Now - byFullCtor.CreatedAt).TotalMinutes < 1);
            Check("ToString shows role and content",
                  byFullCtor.ToString() == "[System] be brief");

            Console.WriteLine();
            Console.WriteLine("[core] Conversation");

            Conversation conversation = new Conversation();
            conversation.AddUserMessage("hi there");
            conversation.AddAssistantMessage("hello!");
            Check("Add increases Count", conversation.Count == 2);
            Check("Render contains the user line", conversation.Render().Contains("[User] hi there"));
            Check("Render contains the assistant line", conversation.Render().Contains("[Assistant] hello!"));

            Conversation bounded = new Conversation(3);
            bounded.AddUserMessage("oldest");
            bounded.AddUserMessage("m1");
            bounded.AddUserMessage("m2");
            bounded.AddUserMessage("m3");
            Check("history trims to MaxMessages", bounded.Count == 3);
            Check("oldest message was dropped", bounded.Messages[0].Content == "m1");

            bounded.Clear();
            Check("Clear resets the history", bounded.Count == 0);

            Console.WriteLine();
            Console.WriteLine("[core] ApiSettings (v0.8.0 key rules)");

            ApiSettings defaults = new ApiSettings();
            Check("default endpoint is OpenRouter chat completions",
                  defaults.EndpointUrl == "https://openrouter.ai/api/v1/chat/completions");
            Check("default model is the pinned flint model",
                  defaults.ModelName == "recursive/flint-v1.0:free");
            Check("default timeout is sane", defaults.TimeoutSeconds >= 30);
            Check("default key is empty (keys never live in source control)", defaults.ApiKey == "");

            // v0.8.0 regression pins: a blank key argument must never throw and
            // never corrupt the settings (the env-var-missing case used to
            // wipe keys through the old ctor - the combo-hijack companion bug).
            Check("blank string ctor stays keyless", new ApiSettings("").ApiKey == "");
            Check("whitespace ctor stays keyless", new ApiSettings("   ").ApiKey == "");
            Check("null ctor stays keyless", new ApiSettings(null).ApiKey == "");

            ApiSettings keyed = new ApiSettings("test-key");
            Check("keyed ctor keeps default model", keyed.ModelName == "recursive/flint-v1.0:free");
            Check("keyed ctor stores key", keyed.ApiKey == "test-key");

            ApiSettings keyedAndModel = new ApiSettings("k", "other/model");
            Check("full ctor stores model", keyedAndModel.ModelName == "other/model");
            Check("ctor chaining kept endpoint", keyedAndModel.EndpointUrl == defaults.EndpointUrl);

            Console.WriteLine();
            Console.WriteLine("[core] ChatReply");

            ChatReply reply = new ChatReply("answer text", "recursive/flint-v1.0:free", 1.25);
            Check("reply carries content", reply.Content == "answer text");
            Check("reply carries model", reply.ModelUsed == "recursive/flint-v1.0:free");
            Check("reply carries elapsed seconds", reply.ElapsedSeconds == 1.25);
            Check("ToString includes elapsed", reply.ToString().Contains("1.25"));
        }

        // ------------------------------------------------------------------
        // Provider package (offline only - no network in this section)
        // ------------------------------------------------------------------

        /// <summary>Test stub that always explodes (template-method error wrapping).</summary>
        private class ExplodingProvider : ChatProviderBase
        {
            public ExplodingProvider(ApiSettings settings) : base(settings) { }

            protected override ChatReply DoSend(IReadOnlyList<ChatMessage> messages)
            {
                throw new InvalidOperationException("boom from the stub");
            }

            protected override string GetDisplayName()
            {
                return "ExplodingStub";
            }
        }

        /// <summary>Test stub that always answers (LSP substitution proof).</summary>
        private class LoyalProvider : ChatProviderBase
        {
            public LoyalProvider(ApiSettings settings) : base(settings) { }

            protected override ChatReply DoSend(IReadOnlyList<ChatMessage> messages)
            {
                return new ChatReply("loyal answer", "loyal-stub");
            }

            protected override string GetDisplayName()
            {
                return "LoyalStub";
            }
        }

        private static void RunProviderOfflineTests()
        {
            Console.WriteLine();
            Console.WriteLine("[providers] ProviderFactory");

            ApiSettings settings = new ApiSettings("offline-suite-key");
            ProviderFactory factory = new ProviderFactory(settings);

            IChatProvider echo = factory.Create(ProviderKind.Echo);
            Check("factory creates EchoProvider for kind Echo", echo is EchoProvider);

            IProviderInfo echoInfo = factory.Create(ProviderKind.Echo) as IProviderInfo;
            Check("Echo provider reports ready", echoInfo != null && echoInfo.IsReady);
            Check("Echo provider display name", echoInfo != null && echoInfo.DisplayName == "Echo (offline)");

            IChatProvider openRouter = factory.Create(ProviderKind.OpenRouter);
            Check("factory creates OpenRouterProvider for kind OpenRouter", openRouter is OpenRouterProvider);

            // v0.7.1+ semantics: the keyless state is the DEFAULT (the
            // leaked built-in key was purged); a blank ctor argument keeps it.
            IProviderInfo routerInfo = new ProviderFactory(new ApiSettings()).Create(ProviderKind.OpenRouter) as IProviderInfo;
            Check("OpenRouter NOT ready without a key", routerInfo != null && !routerInfo.IsReady);
            IProviderInfo keyedInfo = factory.Create(ProviderKind.OpenRouter) as IProviderInfo;
            Check("OpenRouter ready with a key", keyedInfo != null && keyedInfo.IsReady);

            Console.WriteLine();
            Console.WriteLine("[providers] EchoProvider (offline twin)");

            ChatReply echoReply = echo.Send(BuildSampleHistory());
            Check("echo reply is non-empty", !string.IsNullOrEmpty(echoReply.Content));
            Check("echo reply model is echo-offline", echoReply.ModelUsed == "echo-offline");
            Check("echo measured elapsed time", echoReply.ElapsedSeconds >= 0);

            IChatProvider echoGreeting = factory.Create(ProviderKind.Echo);
            ChatReply greeting = echoGreeting.Send(new[] { new ChatMessage("hello") });
            Check("echo greets on 'hello'", greeting.Content.Contains("Hello"));

            Console.WriteLine();
            Console.WriteLine("[providers] ChatProviderBase template method");

            ExplodingProvider bomber = new ExplodingProvider(settings);
            bool wrappedCleanly = false;
            try
            {
                bomber.Send(BuildSampleHistory());
            }
            catch (ProviderException ex)
            {
                wrappedCleanly = ex.Message.Contains("ExplodingStub failed")
                                 && ex.Message.Contains("boom from the stub");
            }
            Check("stub crash is wrapped in ProviderException with context", wrappedCleanly);

            LoyalProvider loyal = new LoyalProvider(settings);
            ChatReply loyalReply = loyal.Send(BuildSampleHistory());
            Check("loyal stub answer flows through template", loyalReply.Content == "loyal answer");
            Check("template stamps elapsed seconds", loyalReply.ElapsedSeconds >= 0);

            bool rejectedEmpty = false;
            try
            {
                loyal.Send(new ChatMessage[0]);
            }
            catch (ProviderException ex)
            {
                rejectedEmpty = ex.Message.Contains("No messages");
            }
            Check("empty history is rejected with a domain error", rejectedEmpty);

            bool rejectedNotReady = false;
            try
            {
                new ProviderFactory(new ApiSettings()).Create(ProviderKind.OpenRouter).Send(BuildSampleHistory());
            }
            catch (ProviderException ex)
            {
                rejectedNotReady = ex.Message.Contains("not ready");
            }
            Check("keyless OpenRouter send fails with a clean not-ready error", rejectedNotReady);

            Console.WriteLine();
            Console.WriteLine("[providers] Liskov substitution");

            // Both real providers and stubs behind ONE abstraction reference:
            IChatProvider[] pool = { factory.Create(ProviderKind.Echo), new LoyalProvider(settings) };
            bool allAnswered = true;
            foreach (IChatProvider provider in pool)
            {
                ChatReply r = provider.Send(BuildSampleHistory());
                allAnswered = allAnswered && !string.IsNullOrEmpty(r.Content);
            }
            Check("every IChatProvider substitute answers identically-shaped", allAnswered);
        }

        // ------------------------------------------------------------------
        // JSON wire contract (offline - pinned request/response shapes)
        // ------------------------------------------------------------------

        private static void RunJsonWireTests()
        {
            Console.WriteLine();
            Console.WriteLine("[wire] request serialization");

            ApiSettings settings = new ApiSettings("wire-suite-key");
            ChatCompletionRequest request = new ChatCompletionRequest
            {
                Model = settings.ModelName,
                Messages = OpenRouterProvider.MapMessages(BuildSampleHistory())
            };
            string body = System.Text.Json.JsonSerializer.Serialize(request,
                new System.Text.Json.JsonSerializerOptions
                {
                    DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull
                });

            Check("body carries the pinned model", body.Contains("\"model\":\"recursive/flint-v1.0:free\""));
            Check("body carries system role", body.Contains("\"role\":\"system\""));
            Check("body carries user role", body.Contains("\"role\":\"user\""));
            Check("body carries assistant role", body.Contains("\"role\":\"assistant\""));
            Check("request omits null fields (no reasoning sent)", !body.Contains("reasoning"));
            Check("exactly 4 mapped messages", request.Messages.Count == 4);
            Check("domain User role maps to wire 'user'", request.Messages[1].Role == "user");

            Console.WriteLine();
            Console.WriteLine("[wire] response parsing");

            string normalJson = "{\"id\":\"x\",\"model\":\"recursive/flint-v1.0:free\",\"choices\":[{\"index\":0,"
                + "\"finish_reason\":\"stop\",\"message\":{\"role\":\"assistant\",\"content\":\"2 plus 2 equals 4.\"}}]}";
            ChatReply normal = OpenRouterProvider.ParseResponse(normalJson);
            Check("normal content parsed", normal.Content == "2 plus 2 equals 4.");
            Check("model rides the reply", normal.ModelUsed == "recursive/flint-v1.0:free");

            string quirkJson = "{\"model\":\"some/reasoning-model\",\"choices\":[{\"index\":0,"
                + "\"message\":{\"role\":\"assistant\",\"content\":\"\",\"reasoning\":\"I reasoned about it deeply\"}}]}";
            ChatReply quirk = OpenRouterProvider.ParseResponse(quirkJson);
            Check("reasoning-only answer falls back to [thinking] excerpt",
                  quirk.Content.StartsWith("[thinking]") && quirk.Content.Contains("reasoned about it"));

            string emptyJson = "{\"model\":\"m\",\"choices\":[{\"index\":0,\"message\":{\"role\":\"assistant\",\"content\":\"\"}}]}";
            bool emptyThrew = false;
            try { OpenRouterProvider.ParseResponse(emptyJson); }
            catch (ProviderException ex) { emptyThrew = ex.Message.Contains("empty answer"); }
            Check("truly empty answer throws a clean domain error", emptyThrew);

            string noChoicesJson = "{\"model\":\"m\",\"choices\":[]}";
            bool noChoicesThrew = false;
            try { OpenRouterProvider.ParseResponse(noChoicesJson); }
            catch (ProviderException ex) { noChoicesThrew = ex.Message.Contains("no choices"); }
            Check("empty choices array throws a clean domain error", noChoicesThrew);

            bool malformedThrew = false;
            try { OpenRouterProvider.ParseResponse("{ not json "); }
            catch (ProviderException ex) { malformedThrew = ex.Message.Contains("unreadable JSON"); }
            Check("malformed JSON throws a clean domain error", malformedThrew);
        }

        // ------------------------------------------------------------------
        // Live suite (network + real key). Run with:  -- live
        // ------------------------------------------------------------------

        private static void RunLiveTests()
        {
            Console.WriteLine();
            Console.WriteLine("[live] foreign OpenAI-compatible endpoint (LIVE_WIRE_*)");

            // v0.8.0: prove the adapter against ANY OpenAI-compatible endpoint
            // while the OpenRouter key is being replaced. Reads env vars only -
            // no key ever enters source control.
            string wireUrl = Environment.GetEnvironmentVariable("LIVE_WIRE_URL");
            string wireKey = Environment.GetEnvironmentVariable("LIVE_WIRE_KEY");
            string wireModel = Environment.GetEnvironmentVariable("LIVE_WIRE_MODEL");
            if (!string.IsNullOrWhiteSpace(wireUrl) && !string.IsNullOrWhiteSpace(wireKey))
            {
                ApiSettings wire = new ApiSettings(wireKey) { EndpointUrl = wireUrl };
                if (!string.IsNullOrWhiteSpace(wireModel))
                {
                    wire.ModelName = wireModel;
                }
                OpenRouterProvider adapter = new OpenRouterProvider(wire);
                ChatReply wireReply = adapter.Send(new[]
                {
                    new ChatMessage("What is 2+2? Answer in one short sentence.")
                });
                Check("live wire: adapter answers through a foreign endpoint",
                      !string.IsNullOrWhiteSpace(wireReply.Content));
                Check("live wire: elapsed seconds measured live", wireReply.ElapsedSeconds > 0);
            }
            else
            {
                Console.WriteLine("  [skip] LIVE_WIRE_URL / LIVE_WIRE_KEY not set");
            }

            Console.WriteLine();
            Console.WriteLine("[live] real OpenRouter calls (pinned model)");

            string key = Environment.GetEnvironmentVariable("OPENROUTER_API_KEY");
            if (string.IsNullOrWhiteSpace(key))
            {
                Console.WriteLine();
                Console.WriteLine("[live] OPENROUTER_API_KEY not set - live OpenRouter suite skipped");
                Console.WriteLine("       (set it to a fresh key from https://openrouter.ai/keys to run");
                Console.WriteLine("        the live OpenRouter pins; the LIVE_WIRE_* proof above already");
                Console.WriteLine("        validates the same adapter code path)");
                return;
            }

            ApiSettings settings = new ApiSettings(key);
            OpenRouterProvider provider = new OpenRouterProvider(settings);

            ChatReply simple = provider.Send(new[] { new ChatMessage("What is 2+2? Answer in one short sentence.") });
            Check("simple math answered", !string.IsNullOrWhiteSpace(simple.Content));

            ChatReply arabic = provider.Send(new[] { new ChatMessage("\u0642\u0644 \u0645\u0631\u062D\u0628\u0627 \u0628\u0627\u0644\u0639\u0631\u0628\u064A\u0629 \u0628\u062C\u0645\u0644\u0629 \u0648\u0627\u062D\u062F\u0629.") });
            Check("arabic input answered", !string.IsNullOrWhiteSpace(arabic.Content));

            ChatReply emoji = provider.Send(new[] { new ChatMessage("Reply with exactly one emoji.") });
            Check("emoji request answered", !string.IsNullOrWhiteSpace(emoji.Content));

            string longText = new string('a', 400) + " ... summarize this in five words";
            ChatReply longInput = provider.Send(new[] { new ChatMessage(longText) });
            Check("long input answered", !string.IsNullOrWhiteSpace(longInput.Content));

            ApiSettings badKey = new ApiSettings("definitely-wrong-key-for-tests");
            OpenRouterProvider badProvider = new OpenRouterProvider(badKey);
            bool badRejected = false;
            try
            {
                badProvider.Send(new[] { new ChatMessage("ping") });
            }
            catch (ProviderException ex)
            {
                badRejected = ex.Message.Contains("401") && ex.Message.Contains("openrouter.ai/keys");
            }
            Check("wrong key surfaces a clean, actionable 401 domain error", badRejected);
        }

        // ------------------------------------------------------------------
        // ChatService (singleton facade) - offline behaviour only
        // ------------------------------------------------------------------

        private static void RunServiceTests()
        {
            Console.WriteLine();
            Console.WriteLine("[service] ChatService singleton");

            ChatService first = ChatService.GetInstance();
            ChatService second = ChatService.GetInstance();
            Check("GetInstance returns the same instance", ReferenceEquals(first, second));

            Check("system prompt seeded on construction",
                  first.History.Count >= 1 && first.History.Messages[0].Role == ChatRole.System);

            Console.WriteLine();
            Console.WriteLine("[service] conversation memory + provider switch");

            first.SwitchProvider(ProviderKind.Echo);
            Check("switched provider name", first.ProviderName == "Echo (offline)");
            Check("echo provider is ready", first.ProviderReady);

            int before = first.History.Count;
            ChatReply reply = first.SendUserMessage("hello service");
            Check("service returned a reply", !string.IsNullOrWhiteSpace(reply.Content));
            Check("history grew by user + assistant lines", first.History.Count == before + 2);
            Check("last history line is the assistant answer",
                  first.History.Messages[first.History.Count - 1].Role == ChatRole.Assistant);

            // Memory: the second send must SEE the first turn in its history.
            ChatReply secondReply = first.SendUserMessage("and again");
            Check("second turn still answered", !string.IsNullOrWhiteSpace(secondReply.Content));
            Check("history keeps growing across turns", first.History.Count == before + 4);

            // v0.8.0 regression: many sends in a row must all land (the
            // "only one message then the app dies" report).
            for (int i = 0; i < 5; i++)
            {
                first.SendUserMessage("stress turn " + i);
            }
            Check("five more sends in a row all answered", first.History.Count == before + 4 + 10);

            Console.WriteLine();
            Console.WriteLine("[service] guards + reset + selection-is-final");

            bool emptyRejected = false;
            try { first.SendUserMessage("   "); }
            catch (ProviderException ex) { emptyRejected = ex.Message.Contains("Type a message"); }
            Check("whitespace-only message rejected with a clean error", emptyRejected);

            first.Reset();
            Check("reset leaves only the system prompt", first.History.Count == 1);

            // v0.8.0: readiness follows the env var (blank = keyless, and the
            // selection stays FINAL either way - the combo-hijack removal).
            string envKey = Environment.GetEnvironmentVariable("OPENROUTER_API_KEY");
            bool expectedReady = !string.IsNullOrWhiteSpace(envKey);
            first.SwitchProvider(ProviderKind.OpenRouter);
            Check("OpenRouter readiness reflects key availability",
                  first.ProviderReady == expectedReady);
            Check("OpenRouter display name", first.ProviderName == "OpenRouter");

            bool switchNeverThrows = true;
            try
            {
                first.SwitchProvider(ProviderKind.Echo);
                first.SwitchProvider(ProviderKind.OpenRouter);
                first.SwitchProvider(ProviderKind.Echo);
            }
            catch (ProviderException)
            {
                switchNeverThrows = false;
            }
            Check("rapid provider switching never throws (selection is final)", switchNeverThrows);
            Check("provider settles on the last choice", first.ProviderName == "Echo (offline)");
        }

        private static IReadOnlyList<ChatMessage> BuildSampleHistory()
        {
            return new[]
            {
                new ChatMessage(ChatRole.System, "You are DCLbot."),
                new ChatMessage("hi there"),
                new ChatMessage(ChatRole.Assistant, "hello!"),
                new ChatMessage("what can you do?")
            };
        }
    }
}
