using System.Collections.Generic;
using DCLbot.Core;

namespace DCLbot.Providers
{
    /// <summary>
    /// The ONE ability every chat provider must have (Interface Segregation:
    /// kept deliberately small). Interchangeable implementations make this a
    /// Strategy pattern and the backbone of the Liskov substitution proof.
    /// </summary>
    public interface IChatProvider
    {
        ChatReply Send(IReadOnlyList<ChatMessage> messages);
    }
}
