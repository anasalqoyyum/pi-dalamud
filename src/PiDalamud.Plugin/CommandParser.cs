namespace PiDalamud.Plugin;

public enum PiCommandKind
{
    Open,
    Stop,
    Status,
    NewSession,
    Prompt,
}

public sealed record PiCommand(PiCommandKind Kind, string? Prompt);

public static class CommandParser
{
    public static PiCommand Parse(string arguments)
    {
        var trimmed = arguments.Trim();
        if (trimmed.Length == 0)
        {
            return new PiCommand(PiCommandKind.Open, null);
        }

        if (trimmed.Equals("stop", StringComparison.OrdinalIgnoreCase))
        {
            return new PiCommand(PiCommandKind.Stop, null);
        }

        if (trimmed.Equals("status", StringComparison.OrdinalIgnoreCase))
        {
            return new PiCommand(PiCommandKind.Status, null);
        }

        if (trimmed.Equals("new", StringComparison.OrdinalIgnoreCase))
        {
            return new PiCommand(PiCommandKind.NewSession, null);
        }

        return new PiCommand(PiCommandKind.Prompt, trimmed);
    }
}
