using System;
using System.Collections.Generic;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using DoomalayLite.Core;
using DoomalayLite.Providers.Dto;

namespace DoomalayLite.Providers
{
    /// <summary>
    /// ADAPTER (GoF): translates between our clean domain world
    /// (IChatProvider / ChatMessage / ChatReply) and OpenRouter's REST/JSON
    /// contract (ChatCompletionRequest / ChatCompletionResponse DTOs).
    /// Also carries the "provider quirk" idea ported from doomalay's
    /// provider_quirks.json: reasoning models can answer with empty content.
    /// </summary>
    public class OpenRouterProvider : ChatProviderBase
    {
        private static readonly JsonSerializerOptions ReadOptions =
            new JsonSerializerOptions { PropertyNameCaseInsensitive = true };

        private static readonly JsonSerializerOptions WriteOptions =
            new JsonSerializerOptions { DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull };

        private HttpClient _http;

        public OpenRouterProvider(ApiSettings settings)
            : base(settings)
        {
            _http = new HttpClient();
            _http.Timeout = TimeSpan.FromSeconds(Math.Max(5, settings.TimeoutSeconds));
        }

        protected override string GetDisplayName()
        {
            return "OpenRouter";
        }

        /// <summary>Ready only when a key was configured.</summary>
        protected override bool ValidateSettings()
        {
            return !string.IsNullOrWhiteSpace(Settings.ApiKey);
        }

        protected override ChatReply DoSend(IReadOnlyList<ChatMessage> messages)
        {
            ChatCompletionRequest request = BuildRequest(messages);
            string payload = Post(request);
            return ParseResponse(payload);
        }

        // ------------------------------------------------------------------
        // domain -> wire
        // ------------------------------------------------------------------

        private ChatCompletionRequest BuildRequest(IReadOnlyList<ChatMessage> messages)
        {
            return new ChatCompletionRequest
            {
                Model = Settings.ModelName,
                Messages = MapMessages(messages)
            };
        }

        /// <summary>Static so the smoke suite can pin the exact wire shape.</summary>
        internal static List<RequestMessage> MapMessages(IReadOnlyList<ChatMessage> messages)
        {
            List<RequestMessage> mapped = new List<RequestMessage>();
            foreach (ChatMessage message in messages)
            {
                string role;
                switch (message.Role)
                {
                    case ChatRole.System:
                        role = "system";
                        break;
                    case ChatRole.Assistant:
                        role = "assistant";
                        break;
                    default:
                        role = "user";
                        break;
                }
                mapped.Add(new RequestMessage { Role = role, Content = message.Content });
            }
            return mapped;
        }

        // ------------------------------------------------------------------
        // HTTP
        // ------------------------------------------------------------------

        private string Post(ChatCompletionRequest request)
        {
            string body = JsonSerializer.Serialize(request, WriteOptions);

            using (HttpRequestMessage http = new HttpRequestMessage(HttpMethod.Post, Settings.EndpointUrl))
            {
                http.Content = new StringContent(body, Encoding.UTF8, "application/json");
                http.Headers.Authorization = new AuthenticationHeaderValue("Bearer", Settings.ApiKey);
                http.Headers.TryAddWithoutValidation("HTTP-Referer", "https://github.com/ScoobyBaby1999/doomalay");
                http.Headers.TryAddWithoutValidation("X-Title", "Doomalay Lite (CSC 323)");

                using (HttpResponseMessage response = _http.SendAsync(http).GetAwaiter().GetResult())
                {
                    string payload = response.Content.ReadAsStringAsync().GetAwaiter().GetResult();

                    if ((int)response.StatusCode == 401)
                    {
                        throw new ProviderException(
                            "OpenRouter rejected the API key (401). Check the OPENROUTER_API_KEY environment variable.");
                    }
                    if ((int)response.StatusCode == 429)
                    {
                        throw new ProviderException(
                            "OpenRouter rate limit reached (429). Free pools are shared - retry shortly or switch to the offline Echo provider.");
                    }
                    if (!response.IsSuccessStatusCode)
                    {
                        throw new ProviderException("OpenRouter HTTP " + (int)response.StatusCode
                                                    + ": " + TextUtils.Truncate(payload, 300));
                    }
                    return payload;
                }
            }
        }

        // ------------------------------------------------------------------
        // wire -> domain
        // ------------------------------------------------------------------

        /// <summary>Static + internal so the smoke suite can test the quirk paths offline.</summary>
        internal static ChatReply ParseResponse(string json)
        {
            ChatCompletionResponse parsed;
            try
            {
                parsed = JsonSerializer.Deserialize<ChatCompletionResponse>(json, ReadOptions);
            }
            catch (JsonException ex)
            {
                throw new ProviderException("OpenRouter returned unreadable JSON: " + ex.Message, ex);
            }

            if (parsed == null || parsed.Choices == null || parsed.Choices.Count == 0)
            {
                throw new ProviderException("OpenRouter response contained no choices.");
            }

            Choice best = parsed.Choices[0];
            string content = (best.Message == null) ? null : best.Message.Content;

            // Provider quirk (ported from doomalay provider_quirks.json):
            // reasoning models may spend the whole token budget thinking and
            // return empty content while the answer sits in "reasoning".
            if (string.IsNullOrWhiteSpace(content))
            {
                string reasoning = (best.Message == null) ? null : best.Message.Reasoning;
                if (!string.IsNullOrWhiteSpace(reasoning))
                {
                    return new ChatReply("[thinking] " + TextUtils.Truncate(reasoning, 240),
                                         parsed.Model ?? "openrouter");
                }
                throw new ProviderException("OpenRouter returned an empty answer (model produced no content).");
            }

            return new ChatReply(content, parsed.Model ?? "openrouter");
        }
    }
}
