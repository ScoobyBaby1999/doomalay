using System;
using System.Collections.Generic;
using DCLbot.Core;

namespace DCLbot.Providers
{
    // The offline provider. It never touches the internet - it just
    // makes up a simple answer from the message. This way the app
    // still works with no Wi-Fi or no API key.
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

        // Echo needs nothing, so it is always ready.
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

        // Look at the words in the message and pick a fitting answer.
        // If nothing matches, return one of a few random lines.
        private string PickReply(string input)
        {
            string lower = input.ToLowerInvariant();

            if (lower.Contains("hello") || lower.Contains("hi ") || lower == "hi" || lower.Contains("hey"))
            {
                return "Hello! I am the offline Echo twin of DCLbot.";
            }
            if (lower.Contains("your name"))
            {
                return "I am DCLbot running in offline Echo mode.";
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
                "You said: \"" + TextUtils.Truncate(input, 80) + "\"",
                "Echo mode heard " + CountWords(input) + " words.",
                "Offline mode is alive and echoing. Try 'hello' or ask me my name.",
                "Message received, processed locally, zero tokens spent."
            };
            return fallbacks[_random.Next(fallbacks.Length)];
        }

        // Counts the words by watching when we step over a space.
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
