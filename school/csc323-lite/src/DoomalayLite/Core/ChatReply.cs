namespace DoomalayLite.Core
{
    /// <summary>
    /// Domain-level answer returned by any IChatProvider.
    /// DTOs from the vendor world never leak past the provider layer (Adapter).
    /// </summary>
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
