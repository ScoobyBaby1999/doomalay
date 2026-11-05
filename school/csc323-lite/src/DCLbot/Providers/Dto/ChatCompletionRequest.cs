using System.Collections.Generic;
using System.Text.Json.Serialization;

namespace DCLbot.Providers.Dto
{
    // The JSON the app sends to OpenRouter. It only needs the model
    // name and the message list.
    public class ChatCompletionRequest
    {
        [JsonPropertyName("model")]
        public string Model { get; set; }

        [JsonPropertyName("messages")]
        public List<RequestMessage> Messages { get; set; }
    }
}
