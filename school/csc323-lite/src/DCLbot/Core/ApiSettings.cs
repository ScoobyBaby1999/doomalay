namespace DCLbot.Core
{
    /// <summary>
    /// Endpoint, model, key, timeout and the system prompt.
    /// Demonstrates constructor overloading with this() chaining (course Ch.3).
    ///
    /// v0.8.0 key rules: real keys NEVER live in source control (v0.7.1 purged
    /// the accidentally committed one) - the OPENROUTER_API_KEY environment
    /// variable is the supported path and always wins when set. A blank/null/
    /// whitespace key argument means "no override - keep the default", so a
    /// missing env var can never crash or corrupt the configuration.
    /// </summary>
    public class ApiSettings
    {
        public string EndpointUrl { get; set; }

        public string ModelName { get; set; }

        public string ApiKey { get; set; }

        public int TimeoutSeconds { get; set; }

        public string SystemPrompt { get; set; }

        /// <summary>
        /// Defaults: OpenRouter endpoint + the one pinned model. The key starts
        /// empty - real keys NEVER live in source control (env var only).
        /// </summary>
        public ApiSettings()
        {
            EndpointUrl = "https://openrouter.ai/api/v1/chat/completions";
            ModelName = "recursive/flint-v1.0:free";
            TimeoutSeconds = 90;
            ApiKey = "";
            SystemPrompt = "You are DCLbot, a concise and helpful assistant. Answer briefly.";
        }

        public ApiSettings(string apiKey)
            : this()
        {
            // v0.8.0: only a REAL key overrides; blank means "nothing
            // supplied" (the env-var-missing case) and keeps the default.
            if (!string.IsNullOrWhiteSpace(apiKey))
            {
                ApiKey = apiKey;
            }
        }

        public ApiSettings(string apiKey, string modelName)
            : this(apiKey)
        {
            if (!string.IsNullOrWhiteSpace(modelName))
            {
                ModelName = modelName;
            }
        }
    }
}
