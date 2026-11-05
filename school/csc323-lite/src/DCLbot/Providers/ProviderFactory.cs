using System;

using DCLbot.Core;

namespace DCLbot.Providers
{
    // Makes whichever provider the user asked for. If I ever add a new
    // provider, it is just one more case here.
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
