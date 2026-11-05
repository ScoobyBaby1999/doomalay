using System.Collections.Generic;
using System.Text.Json.Serialization;

namespace DCLbot.Providers.Dto
{
    // The JSON OpenRouter sends back. I only kept the fields I
    // actually read.
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
