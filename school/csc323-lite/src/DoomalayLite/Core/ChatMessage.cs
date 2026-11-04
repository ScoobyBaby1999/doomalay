using System;

namespace DoomalayLite.Core
{
    /// 
    /// One message in the conversation 
    /// 
    public class ChatMessage
    {
        private DateTime _createdAt;

        public ChatRole Role { get; private set; }

        public string Content { get; set; }

        /// read-only
        public DateTime CreatedAt
        {
            get { return _createdAt; }
        }

        /// prototype - defaults the role to User 
        public ChatMessage(string content)
            : this(ChatRole.User, content)
        {
        }

        /// the full constructor
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
