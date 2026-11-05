using System;
using DCLbot.Core;
using DCLbot.Providers;

namespace DCLbot.Services
{
    // The middle man between the window and everything else. The window
    // only talks to this one class - it never touches the providers or
    // the message classes directly. It keeps the conversation and the
    // current provider, and there is only ever one instance of it in
    // the whole app.
    public class ChatService
    {
        private static ChatService _instance;
        private static readonly object _lock = new object();

        private Conversation _conversation;
        private IChatProvider _provider;
        private IProviderInfo _providerInfo;
        private ApiSettings _settings;

        // Private so nobody else can make a second one.
        private ChatService()
        {
            _settings = new ApiSettings(LoadApiKey());
            _conversation = new Conversation();
            SwitchProvider(ProviderKind.OpenRouter);
            SeedSystemPrompt();
        }

        // Always returns the same instance.
        public static ChatService GetInstance()
        {
            lock (_lock)
            {
                if (_instance == null)
                {
                    _instance = new ChatService();
                }
                return _instance;
            }
        }

        public Conversation History
        {
            get { return _conversation; }
        }

        public string ProviderName
        {
            get { return _providerInfo.DisplayName; }
        }

        public bool ProviderReady
        {
            get { return _providerInfo.IsReady; }
        }

        public string ModelName
        {
            get { return _settings.ModelName; }
        }

        // One full turn: save what the user typed, ask the provider with
        // the WHOLE history (so it remembers), save the answer, return it.
        public ChatReply SendUserMessage(string text)
        {
            if (string.IsNullOrWhiteSpace(text))
            {
                throw new ProviderException("Type a message before sending.");
            }

            _conversation.AddUserMessage(text);
            ChatReply reply = _provider.Send(_conversation.Messages);
            _conversation.AddAssistantMessage(reply.Content);
            return reply;
        }

        // Swap the current provider when the user picks another one in
        // the window. The provider might also give status information,
        // which I keep next to it for the status bar.
        public void SwitchProvider(ProviderKind kind)
        {
            IChatProvider created = new ProviderFactory(_settings).Create(kind);
            _provider = created;
            _providerInfo = created as IProviderInfo;
        }

        // Start a fresh chat: forget everything and put the system
        // prompt back in.
        public void Reset()
        {
            _conversation.Clear();
            SeedSystemPrompt();
        }

        private void SeedSystemPrompt()
        {
            _conversation.Add(new ChatMessage(ChatRole.System, _settings.SystemPrompt));
        }

        // I read the API key from the OPENROUTER_API_KEY environment
        // variable, because keys do not belong inside the code.
        private static string LoadApiKey()
        {
            string key = Environment.GetEnvironmentVariable("OPENROUTER_API_KEY");
            return (key == null) ? "" : key;
        }
    }
}
