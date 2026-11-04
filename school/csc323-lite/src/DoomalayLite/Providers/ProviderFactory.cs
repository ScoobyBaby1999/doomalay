using System;

using DoomalayLite.Core;

namespace DoomalayLite.Providers
{
    /// <summary>
    /// The single composition point: turns a ProviderKind into a live provider.
    /// Adding a provider tomorrow = one new case here, nothing else changes
    /// (Open-Closed in practice).
    /// </summary>
    public class ProviderFactory
    {
        private ApiSettings _settings;

        public ProviderFactory(ApiSettings settings)
        {
            _settings = settings;
        }

        public IChatProvider Create(ProviderKind kind)
        {
            switch (kind)
            {
                case ProviderKind.Echo:
                    return new EchoProvider(_settings);
                case ProviderKind.OpenRouter:
                    return new OpenRouterProvider(_settings);
                default:
                    throw new ProviderException("Unknown provider kind: " + kind);
            }
        }
    }
}
