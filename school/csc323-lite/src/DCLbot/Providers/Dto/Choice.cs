using System.Text.Json.Serialization;

namespace DCLbot.Providers.Dto
{
    /// <summary>
    /// One completion alternative. We always read choices[0].
    /// </summary>
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
