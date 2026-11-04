using System;
using DoomalayLite.Core;
using DoomalayLite.Providers;

namespace DoomalayLite.Services
{
    /// <summary>
    /// SINGLETON + FACADE: exactly one chat brain per application instance, and
    /// the ONLY type the UI needs to know. It hides the Conversation, the
    /// provider Strategy, the factory and every DTO behind a 4-method surface.
    /// </summary>
    public class ChatService
    {
        private static ChatService _instance;
        private static readonly object _lock = new object();

        private Conversation _conversation;
        private IChatProvider _provider;
        private IProviderInfo _providerInfo;
        private ApiSettings _settings;

        /// <summary>Private constructor: only GetInstance() can build us.</summary>
        private ChatService()
        {
            _settings = new ApiSettings(LoadApiKey());
            _conversation = new Conversation();
            SwitchProvider(ProviderKind.OpenRouter);
            SeedSystemPrompt();
        }

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

        /// <summary>
        /// One full turn: remember the user line, ask the active provider with
        /// the WHOLE history (memory), remember the answer, return it.
        /// </summary>
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

        /// <summary>
        /// Strategy switch at runtime. The provider object is reached through
        /// two narrow interfaces at once (send vs. info) - Interface Segregation.
        /// </summary>
        public void SwitchProvider(ProviderKind kind)
        {
            IChatProvider created = new ProviderFactory(_settings).Create(kind);
            _provider = created;
            _providerInfo = created as IProviderInfo; // 'as' operator: Ch.3
        }

        /// <summary>Starts a fresh conversation (system prompt re-seeded).</summary>
        public void Reset()
        {
            _conversation.Clear();
            SeedSystemPrompt();
        }

        private void SeedSystemPrompt()
        {
            _conversation.Add(new ChatMessage(ChatRole.System, _settings.SystemPrompt));
        }

        /// <summary>
        /// Keys NEVER live in source control: read from the environment.
        /// </summary>
        private static string LoadApiKey()
        {
            string key = Environment.GetEnvironmentVariable("OPENROUTER_API_KEY");
            return (key == null) ? "" : key;
        }
    }
}
