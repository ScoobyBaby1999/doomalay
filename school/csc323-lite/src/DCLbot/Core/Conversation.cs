using System.Collections.Generic;
using System.Text;

namespace DCLbot.Core
{
    /// <summary>
    /// The in-memory chat history (doomalay lineage: engine/internal/store/chats.go).
    /// Owns the List&lt;ChatMessage&gt; collection and renders the transcript.
    /// </summary>
    public class Conversation
    {
        private List<ChatMessage> _messages;
        private int _maxMessages;

        /// <summary>Defaults to keeping the last 40 messages.</summary>
        public Conversation()
            : this(40)
        {
        }

        public Conversation(int maxMessages)
        {
            _messages = new List<ChatMessage>();
            _maxMessages = maxMessages;
        }

        public int Count
        {
            get { return _messages.Count; }
        }

        public int MaxMessages
        {
            get { return _maxMessages; }
        }

        /// <summary>Exposed read-only so callers cannot bypass Add/Trim.</summary>
        public IReadOnlyList<ChatMessage> Messages
        {
            get { return _messages; }
        }

        public void Add(ChatMessage message)
        {
            _messages.Add(message);
            Trim();
        }

        public void AddUserMessage(string content)
        {
            Add(new ChatMessage(ChatRole.User, content));
        }

        public void AddAssistantMessage(string content)
        {
            Add(new ChatMessage(ChatRole.Assistant, content));
        }

        public void Clear()
        {
            _messages.Clear();
        }

        /// <summary>foreach loop (course key concept) building the visible transcript.</summary>
        public string Render()
        {
            StringBuilder sb = new StringBuilder();
            foreach (ChatMessage message in _messages)
            {
                sb.AppendLine(message.ToString());
            }
            return sb.ToString();
        }

        /// <summary>Keeps memory bounded: drops the oldest messages first.</summary>
        private void Trim()
        {
            while (_messages.Count > _maxMessages)
            {
                _messages.RemoveAt(0);
            }
        }
    }
}
