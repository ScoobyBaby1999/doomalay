using System.Collections.Generic;
using DCLbot.Core;

namespace DCLbot.Providers
{
    // The one thing every provider must be able to do: take the
    // conversation so far and give back one reply.
    public interface IChatProvider
    {
        ChatReply Send(IReadOnlyList<ChatMessage> messages);
    }
}
