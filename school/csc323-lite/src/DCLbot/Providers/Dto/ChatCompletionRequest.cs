using System.Collections.Generic;
using System.Text.Json.Serialization;

namespace DCLbot.Providers.Dto
{
    /// <summary>
    /// POST body of POST /api/v1/chat/completions (OpenAI-compatible shape).
    /// </summary>
    public class ChatCompletionRequest
    {
        [JsonPropertyName("model")]
        public string Model { get; set; }

        [JsonPropertyName("messages")]
        public List<RequestMessage> Messages { get; set; }
    }
}
