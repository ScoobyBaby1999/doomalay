namespace DoomalayLite.Core
{
    /// <summary>
    /// Endpoint, model, key, timeout and the system prompt.
    /// Demonstrates constructor overloading with this() chaining (course Ch.3).
    /// </summary>
    public class ApiSettings
    {
        public string EndpointUrl { get; set; }

        public string ModelName { get; set; }

        public string ApiKey { get; set; }

        public int TimeoutSeconds { get; set; }

        public string SystemPrompt { get; set; }

        /// <summary>Defaults: OpenRouter endpoint + the one pinned model.</summary>
        public ApiSettings()
        {
            EndpointUrl = "https://openrouter.ai/api/v1/chat/completions";
            ModelName = "recursive/flint-v1.0:free";
            TimeoutSeconds = 90;
            ApiKey = "";
            SystemPrompt = "You are Doomalay Lite, a concise and helpful assistant. Answer briefly.";
        }

        public ApiSettings(string apiKey)
            : this()
        {
            ApiKey = apiKey;
        }

        public ApiSettings(string apiKey, string modelName)
            : this(apiKey)
        {
            ModelName = modelName;
        }
    }
}
