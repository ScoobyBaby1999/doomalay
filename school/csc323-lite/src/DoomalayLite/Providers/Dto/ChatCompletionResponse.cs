using System.Collections.Generic;
using System.Text.Json.Serialization;

namespace DoomalayLite.Providers.Dto
{
    /// <summary>
    /// Response of POST /api/v1/chat/completions - only the fields we consume.
    /// </summary>
    public class ChatCompletionResponse
    {
        [JsonPropertyName("id")]
        public string Id { get; set; }

        [JsonPropertyName("model")]
        public string Model { get; set; }

        [JsonPropertyName("choices")]
        public List<Choice> Choices { get; set; }
    }
}
