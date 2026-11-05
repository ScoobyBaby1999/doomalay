namespace DCLbot.Providers
{
    // Just the status side of a provider: its name and whether it can
    // be used right now. The main window uses this for the status bar.
    public interface IProviderInfo
    {
        string DisplayName { get; }

        bool IsReady { get; }
    }
}
