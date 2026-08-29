using PiDalamud.Plugin;

namespace PiDalamud.Plugin.Tests;

public sealed class CommandParserTests
{
    [Theory]
    [InlineData("", PiCommandKind.Open, null)]
    [InlineData("   ", PiCommandKind.Open, null)]
    [InlineData("stop", PiCommandKind.Stop, null)]
    [InlineData(" STATUS ", PiCommandKind.Status, null)]
    [InlineData("new", PiCommandKind.NewSession, null)]
    [InlineData("stop now", PiCommandKind.Prompt, "stop now")]
    [InlineData("explain this", PiCommandKind.Prompt, "explain this")]
    public void ParsesCommandsInSpecifiedOrder(string input, PiCommandKind kind, string? prompt)
    {
        Assert.Equal(new PiCommand(kind, prompt), CommandParser.Parse(input));
    }
}
