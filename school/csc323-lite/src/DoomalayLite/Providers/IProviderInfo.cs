namespace DoomalayLite.Providers
{
    /// <summary>
    /// Status-only surface (Interface Segregation): consumers that only need
    /// to display provider metadata never depend on IChatProvider.
    /// </summary>
    public interface IProviderInfo
    {
        string DisplayName { get; }

        bool IsReady { get; }
    }
}
