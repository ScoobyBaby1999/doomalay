using System.Text.Json.Serialization;

namespace DCLbot.Providers.Dto
{
    // One possible answer. OpenRouter can send several, but I always
    // use the first one.
    public class Choice
    {
        [JsonPropertyName("index")]
        public int Index { get; set; }

        [JsonPropertyName("message")]
        public RequestMessage Message { get; set; }

        [JsonPropertyName("finish_reason")]
        public string FinishReason { get; set; }
    }
}
