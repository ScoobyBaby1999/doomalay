using System;
using System.Collections.Generic;
using System.Diagnostics;
using DCLbot.Core;

namespace DCLbot.Providers
{
    // The shared part of every provider. Send() does the checks that
    // are the same for everyone (is there anything to send, is the
    // provider ready), measures the time, and turns any unexpected
    // crash into a ProviderException so the window only ever has to
    // deal with one kind of error.
    public abstract class ChatProviderBase : IChatProvider, IProviderInfo
    {
        // The settings every provider needs, available to subclasses only.
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

        // Check everything first, then let the subclass do the real work.
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
                throw; // my own errors already have a good message
            }
            catch (Exception ex)
            {
                throw new ProviderException(DisplayName + " failed: " + ex.Message, ex);
            }
        }

        // Each provider fills this in with its own way of getting an answer.
        protected abstract ChatReply DoSend(IReadOnlyList<ChatMessage> messages);

        // The name shown to the user in the window.
        protected abstract string GetDisplayName();

        // Whether this provider can be used right now.
        protected virtual bool ValidateSettings()
        {
            return true;
        }
    }
}
