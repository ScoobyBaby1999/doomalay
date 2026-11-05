using System.Text.Json.Serialization;

namespace DCLbot.Providers.Dto
{
    // One message in the JSON format: {"role":"...","content":"..."}.
    // "reasoning" only appears in answers from thinking models, so I
    // never set it myself when sending.
    public class RequestMessage
    {
        [JsonPropertyName("role")]
        public string Role { get; set; }

        [JsonPropertyName("content")]
        public string Content { get; set; }

        [JsonPropertyName("reasoning")]
        public string Reasoning { get; set; }
    }
}
