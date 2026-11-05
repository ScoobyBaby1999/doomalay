using System.Text.Json.Serialization;

namespace DCLbot.Providers.Dto
{
    /// <summary>
    /// One wire-format message: {"role":"...","content":"..."}.
    /// Reasoning is response-only (quirk field of reasoning models).
    /// </summary>
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
