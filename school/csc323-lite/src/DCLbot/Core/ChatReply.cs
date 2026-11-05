namespace DCLbot.Core
{
    // The answer that comes back from a provider: the text itself,
    // which model answered, and how many seconds it took.
    public class ChatReply
    {
        public string Content { get; set; }

        public string ModelUsed { get; set; }

        public double ElapsedSeconds { get; set; }

        public ChatReply(string content, string modelUsed)
        {
            Content = content;
            ModelUsed = modelUsed;
            ElapsedSeconds = 0;
        }

        public ChatReply(string content, string modelUsed, double elapsedSeconds)
            : this(content, modelUsed)
        {
            ElapsedSeconds = elapsedSeconds;
        }

        public override string ToString()
        {
            return string.Format("{0} ({1}, {2}s)", Content, ModelUsed, ElapsedSeconds);
        }
    }
}
