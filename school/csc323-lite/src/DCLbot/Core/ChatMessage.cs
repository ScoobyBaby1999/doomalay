using System;

namespace DCLbot.Core
{
    /// <summary>
    /// One message in the conversation (doomalay lineage: a chat row).
    /// Demonstrates constructor overloading and method overriding (ToString).
    /// </summary>
    public class ChatMessage
    {
        private DateTime _createdAt;

        public ChatRole Role { get; private set; }

        public string Content { get; set; }

        /// <summary>Read-only property backed by a private field.</summary>
        public DateTime CreatedAt
        {
            get { return _createdAt; }
        }

        /// <summary>Convenience constructor: defaults the role to User.</summary>
        public ChatMessage(string content)
            : this(ChatRole.User, content)
        {
        }

        /// <summary>Full constructor.</summary>
        public ChatMessage(ChatRole role, string content)
        {
            Role = role;
            Content = content;
            _createdAt = DateTime.Now;
        }

        public override string ToString()
        {
            return string.Format("[{0}] {1}", Role, Content);
        }
    }
}
