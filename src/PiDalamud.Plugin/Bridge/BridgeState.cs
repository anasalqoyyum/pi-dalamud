namespace PiDalamud.Plugin.Bridge;

public enum BridgeConnectionState
{
    Disconnected,
    Connecting,
    Idle,
    Running,
    Error,
}

public enum BridgeRuntimeState
{
    Starting,
    Idle,
    Running,
    Error,
}

public static class ReconnectBackoff
{
    public static TimeSpan ForAttempt(int attempt)
    {
        ArgumentOutOfRangeException.ThrowIfNegative(attempt);
        return TimeSpan.FromSeconds(attempt >= 5 ? 30 : 1 << attempt);
    }
}
