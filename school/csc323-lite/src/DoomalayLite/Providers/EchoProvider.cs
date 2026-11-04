using System;
using System.Collections.Generic;
using DoomalayLite.Core;

namespace DoomalayLite.Providers
{
    /// <summary>
    /// The offline twin: never touches the network, so the classroom demo works
    /// without Wi-Fi and never dies on free-tier rate limits. Liskov proof:
    /// it is perfectly substitutable for OpenRouterProvider behind IChatProvider.
    /// </summary>
    public class EchoProvider : ChatProviderBase
    {
        private Random _random;

        public EchoProvider(ApiSettings settings)
            : base(settings)
        {
            _random = new Random();
        }

        protected override string GetDisplayName()
        {
            return "Echo (offline)";
        }

        /// <summary>Echo is always ready - it needs nothing from the network.</summary>
        protected override bool ValidateSettings()
        {
            return true;
        }

        protected override ChatReply DoSend(IReadOnlyList<ChatMessage> messages)
        {
            ChatMessage last = messages[messages.Count - 1];
            string question = (last.Content == null) ? "" : last.Content.Trim();
            return new ChatReply(PickReply(question), "echo-offline");
        }

        /// <summary>Keyword-flavoured canned replies, with a random fallback.</summary>
        private string PickReply(string input)
        {
            string lower = input.ToLowerInvariant();

            if (lower.Contains("hello") || lower.Contains("hi ") || lower == "hi" || lower.Contains("hey"))
            {
                return "Hello! I am the offline Echo twin of Doomalay Lite.";
            }
            if (lower.Contains("your name"))
            {
                return "I am Doomalay Lite running in offline Echo mode.";
            }
            if (lower.Contains("?"))
            {
                return "Good question! Offline Echo cannot think, but the online provider can - switch providers above.";
            }
            if (input.Length == 0)
            {
                return "You sent an empty message.";
            }

            string[] fallbacks =
            {
                "You said: \"" + Truncate(input, 80) + "\"",
                "Echo mode heard " + CountWords(input) + " words.",
                "Offline mode is alive and echoing. Try 'hello' or ask me my name.",
                "Message received, processed locally, zero tokens spent."
            };
            return fallbacks[_random.Next(fallbacks.Length)];
        }

        private static string Truncate(string text, int max)
        {
            if (text.Length <= max)
            {
                return text;
            }
            return text.Substring(0, max) + "...";
        }

        private static int CountWords(string text)
        {
            int words = 0;
            bool insideWord = false;
            foreach (char c in text)
            {
                bool isSpace = char.IsWhiteSpace(c);
                if (!isSpace && !insideWord)
                {
                    words++;
                }
                insideWord = !isSpace;
            }
            return words;
        }
    }
}
