using System;

namespace DCLbot.Core
{
    // One message in the chat. It remembers who sent it (the role),
    // the text itself, and the time it was created.
    public class ChatMessage
    {
        private DateTime _createdAt;

        public ChatRole Role { get; private set; }

        public string Content { get; set; }

        // The time can be read from outside but not changed.
        public DateTime CreatedAt
        {
            get { return _createdAt; }
        }

        // Shortcut constructor: most messages come from the user.
        public ChatMessage(string content)
            : this(ChatRole.User, content)
        {
        }

        // Full constructor when I need to set the role myself.
        public ChatMessage(ChatRole role, string content)
        {
            Role = role;
            Content = content;
            _createdAt = DateTime.Now;
        }

        // Shows the message as one line, e.g. "[User] hello".
        public override string ToString()
        {
            return string.Format("[{0}] {1}", Role, Content);
        }
    }
}
