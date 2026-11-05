namespace DCLbot.Providers
{
    // Small string helpers that more than one class needs.
    internal static class TextUtils
    {
        // Cuts a long text and adds "..." at the end.
        public static string Truncate(string text, int max)
        {
            if (text == null || text.Length <= max)
            {
                return text;
            }
            return text.Substring(0, max) + "...";
        }
    }
}
