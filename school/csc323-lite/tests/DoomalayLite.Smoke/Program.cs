using System;
using DoomalayLite.Core;

namespace DoomalayLite.Smoke
{
    /// <summary>
    /// Zero-dependency smoke suite. No test framework - a tiny harness only,
    /// so the course project keeps its dependency list clean.
    ///
    ///   dotnet run --project tests/DoomalayLite.Smoke            (offline)
    ///   dotnet run --project tests/DoomalayLite.Smoke -- live    (needs OPENROUTER_API_KEY)
    /// </summary>
    internal static class Program
    {
        private static int _passed;
        private static int _failed;

        static int Main(string[] args)
        {
            Console.WriteLine("Doomalay Lite smoke suite");
            Console.WriteLine("=========================");
            string mode = (args.Length > 0) ? args[0] : "offline";

            RunCoreTests();
            // v0.3.0: RunProviderOfflineTests();
            // v0.4.0: RunJsonWireTests();
            if (mode == "live")
            {
                // v0.4.0: RunLiveTests();
                Console.WriteLine("(live suite arrives in v0.4.0)");
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
            Console.WriteLine("[core] ApiSettings");

            ApiSettings defaults = new ApiSettings();
            Check("default endpoint is OpenRouter chat completions",
                  defaults.EndpointUrl == "https://openrouter.ai/api/v1/chat/completions");
            Check("default model is the pinned flint model",
                  defaults.ModelName == "recursive/flint-v1.0:free");
            Check("default timeout is sane", defaults.TimeoutSeconds >= 30);
            Check("default key is empty", defaults.ApiKey == "");

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
    }
}
