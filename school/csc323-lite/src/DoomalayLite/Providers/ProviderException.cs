using System;

namespace DoomalayLite.Providers
{
    /// <summary>
    /// Domain-level failure of a chat provider. Wraps low-level errors so the
    /// UI never sees raw HttpClient/JSON exceptions (Facade benefit).
    /// </summary>
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
