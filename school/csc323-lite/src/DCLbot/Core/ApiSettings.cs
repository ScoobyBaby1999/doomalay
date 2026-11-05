namespace DCLbot.Core
{
    // All the settings the bot needs to talk to the API in one place:
    // the web address, the model, the API key, a timeout and the
    // system prompt.
    public class ApiSettings
    {
        public string EndpointUrl { get; set; }

        public string ModelName { get; set; }

        public string ApiKey { get; set; }

        public int TimeoutSeconds { get; set; }

        public string SystemPrompt { get; set; }

        // Default settings: the OpenRouter address and the free model
        // I picked. The key starts empty because keys should never be
        // written inside the code - I read mine from an environment
        // variable instead.
        public ApiSettings()
        {
            EndpointUrl = "https://openrouter.ai/api/v1/chat/completions";
            ModelName = "recursive/flint-v1.0:free";
            TimeoutSeconds = 90;
            ApiKey = "";
            SystemPrompt = "You are DCLbot, a concise and helpful assistant. Answer briefly.";
        }

        // An empty key means "no key was given", so I keep the default
        // instead of overwriting the settings with nothing.
        public ApiSettings(string apiKey)
            : this()
        {
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
