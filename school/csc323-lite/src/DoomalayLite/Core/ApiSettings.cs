namespace DoomalayLite.Core
{
    /// 
    /// Endpoint, model, key, timeout and the system prompts
    /// 
    public class ApiSettings
    {
        public string EndpointUrl { get; set; }

        public string ModelName { get; set; }

        public string ApiKey { get; set; }

        public int TimeoutSeconds { get; set; }

        public string SystemPrompt { get; set; }

        /// OpenRouter endpoint + a reliable model and a compromised api key. 
        public ApiSettings()
        {
            EndpointUrl = "https://openrouter.ai/api/v1/chat/completions";
            ModelName = "recursive/flint-v1.0:free";
            TimeoutSeconds = 90;
            ApiKey = "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";
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
