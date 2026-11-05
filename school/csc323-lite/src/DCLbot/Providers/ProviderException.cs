using System;

namespace DCLbot.Providers
{
    // My own error type for provider problems. The window catches this
    // and simply shows the message to the user instead of crashing.
    public class ProviderException : Exception
    {
        public ProviderException(string message)
            : base(message)
        {
        }

        public ProviderException(string message, Exception inner)
            : base(message, inner)
        {
        }
    }
}
