using System;
using System.Collections.Generic;
using System.Diagnostics;
using DoomalayLite.Core;

namespace DoomalayLite.Providers
{
    /// <summary>
    /// Abstract base (course key concept: abstraction) implementing the shared
    /// TEMPLATE METHOD Send(): guard inputs, validate readiness, measure the
    /// elapsed time and translate unexpected failures into ProviderException.
    /// Subclasses only fill in the provider-specific blanks.
    /// </summary>
    public abstract class ChatProviderBase : IChatProvider, IProviderInfo
    {
        /// <summary>Shared configuration, visible to subclasses only (#).</summary>
        protected ApiSettings Settings { get; }

        public string DisplayName
        {
            get { return GetDisplayName(); }
        }

        public bool IsReady
        {
            get { return ValidateSettings(); }
        }

        protected ChatProviderBase(ApiSettings settings)
        {
            Settings = settings;
        }

        /// <summary>
        /// The template method: fixed skeleton, provider-specific blanks below.
        /// </summary>
        public ChatReply Send(IReadOnlyList<ChatMessage> messages)
        {
            if (messages == null || messages.Count == 0)
            {
                throw new ProviderException("No messages to send.");
            }
            if (!IsReady)
            {
                throw new ProviderException(DisplayName + " is not ready: missing configuration.");
            }

            Stopwatch clock = Stopwatch.StartNew();
            try
            {
                ChatReply reply = DoSend(messages);
                clock.Stop();
                reply.ElapsedSeconds = Math.Round(clock.Elapsed.TotalSeconds, 2);
                return reply;
            }
            catch (ProviderException)
            {
                throw; // domain errors pass through untouched
            }
            catch (Exception ex)
            {
                throw new ProviderException(DisplayName + " failed: " + ex.Message, ex);
            }
        }

        /// <summary>Blank 1: how to actually obtain a reply.</summary>
        protected abstract ChatReply DoSend(IReadOnlyList<ChatMessage> messages);

        /// <summary>Blank 2: the human-readable provider name.</summary>
        protected abstract string GetDisplayName();

        /// <summary>Blank 3 (optional): whether this provider can run now.</summary>
        protected virtual bool ValidateSettings()
        {
            return true;
        }
    }
}
