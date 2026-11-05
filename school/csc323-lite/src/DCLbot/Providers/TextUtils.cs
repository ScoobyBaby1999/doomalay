namespace DCLbot.Providers
{
    /// <summary>
    /// Shared string helpers (DRY: one home instead of copies per provider).
    /// </summary>
    internal static class TextUtils
    {
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
