using Dalamud.Configuration;

namespace PiDalamud.Plugin;

[Serializable]
public sealed class Configuration : IPluginConfiguration
{
    public int Version { get; set; } = 1;

    public string BridgeUrl { get; set; } = "ws://127.0.0.1:32145";

    public string BearerToken { get; set; } = string.Empty;

    public bool TryGetConnection(out Uri? endpoint, out string error)
    {
        endpoint = null;
        if (!Uri.TryCreate(BridgeUrl, UriKind.Absolute, out var parsed) ||
            parsed.Scheme != "ws" ||
            parsed.Host != "127.0.0.1" ||
            !string.IsNullOrEmpty(parsed.UserInfo) ||
            parsed.AbsolutePath != "/" ||
            !string.IsNullOrEmpty(parsed.Query) ||
            !string.IsNullOrEmpty(parsed.Fragment))
        {
            error = "Bridge URL must be ws://127.0.0.1:<port> with no path, query, or fragment.";
            return false;
        }

        if (string.IsNullOrWhiteSpace(BearerToken))
        {
            error = "Paste the bridge bearer token.";
            return false;
        }

        endpoint = parsed;
        error = string.Empty;
        return true;
    }
}
