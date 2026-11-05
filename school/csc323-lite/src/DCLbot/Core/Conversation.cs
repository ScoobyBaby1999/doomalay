using System.Collections.Generic;
using System.Text;

namespace DCLbot.Core
{
    // The chat history. It keeps every message in a list and can also
    // draw the whole conversation as one big text for the chat window.
    public class Conversation
    {
        private List<ChatMessage> _messages;
        private int _maxMessages;

        // By default I keep the last 40 messages.
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

        // A read-only view, so nobody can change my list from outside.
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

        // Builds the text shown in the chat window, one line per message.
        public string Render()
        {
            StringBuilder sb = new StringBuilder();
            foreach (ChatMessage message in _messages)
            {
                sb.AppendLine(message.ToString());
            }
            return sb.ToString();
        }

        // If the list gets too long, drop the oldest messages first.
        private void Trim()
        {
            while (_messages.Count > _maxMessages)
            {
                _messages.RemoveAt(0);
            }
        }
    }
}
