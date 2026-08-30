using System.Text;
using PiDalamud.Plugin.Bridge;

namespace PiDalamud.Plugin.Tests;

public sealed class BridgeProtocolTests
{
    [Fact]
    public void ParsesAcceptedAndSettledMessages()
    {
        var accepted = BridgeProtocol.Parse(Encoding.UTF8.GetBytes(
            """{"version":1,"type":"accepted","requestId":"request-1"}"""));
        var settled = BridgeProtocol.Parse(Encoding.UTF8.GetBytes(
            """{"version":1,"type":"settled","requestId":"request-1","sessionId":"session-1","text":"done"}"""));

        Assert.Equal(new AcceptedEvent("request-1"), accepted);
        Assert.Equal(new SettledEvent("request-1", "session-1", "done"), settled);
    }

    [Fact]
    public void ParsesAbortedAndSanitizedErrorMessages()
    {
        var aborted = BridgeProtocol.Parse(Encoding.UTF8.GetBytes(
            """{"version":1,"type":"aborted","requestId":"request-1"}"""));
        var error = BridgeProtocol.Parse(Encoding.UTF8.GetBytes(
            """{"version":1,"type":"error","code":"busy","message":"Pi is running","requestId":"request-1"}"""));

        Assert.Equal(new AbortedEvent("request-1"), aborted);
        Assert.Equal(new BridgeErrorEvent("busy", "Pi is running", "request-1"), error);
    }

    [Fact]
    public void ParsesModelStateAndThinkingCapabilities()
    {
        var message = BridgeProtocol.Parse(Encoding.UTF8.GetBytes(
            """{"version":1,"type":"model_state","preset":"luna","provider":"openai-codex","modelId":"gpt-5.6-luna","thinkingLevel":"max","availableThinkingLevels":["off","high","max"]}"""));

        var state = Assert.IsType<ModelStateEvent>(message);
        Assert.Equal("luna", state.Preset);
        Assert.Equal("openai-codex", state.Provider);
        Assert.Equal("gpt-5.6-luna", state.ModelId);
        Assert.Equal("max", state.ThinkingLevel);
        Assert.Equal(["off", "high", "max"], state.AvailableThinkingLevels);
    }

    [Fact]
    public void ParsesEveryBridgeState()
    {
        foreach (var (wireState, expected) in new[]
                 {
                     ("starting", BridgeRuntimeState.Starting),
                     ("idle", BridgeRuntimeState.Idle),
                     ("running", BridgeRuntimeState.Running),
                     ("error", BridgeRuntimeState.Error),
                 })
        {
            var message = BridgeProtocol.Parse(Encoding.UTF8.GetBytes(
                $$"""{"version":1,"type":"status","state":"{{wireState}}","sessionId":"session-1"}"""));

            Assert.Equal(new StatusEvent(expected, "session-1", null), message);
        }
    }

    [Theory]
    [InlineData("not-json")]
    [InlineData("{\"version\":2,\"type\":\"ready\",\"sessionId\":\"s\",\"state\":\"idle\"}")]
    [InlineData("{\"version\":1e100,\"type\":\"ready\",\"sessionId\":\"s\",\"state\":\"idle\"}")]
    [InlineData("{\"version\":1,\"type\":\"unknown\"}")]
    [InlineData("{\"version\":1,\"type\":\"ready\",\"sessionId\":\"s\",\"state\":\"idle\",\"extra\":true}")]
    [InlineData("{\"version\":1,\"type\":\"accepted\",\"requestId\":\"one\",\"requestId\":\"two\"}")]
    public void RejectsMalformedUnsupportedAndExtensibleMessages(string json)
    {
        Assert.Throws<BridgeProtocolException>(() => BridgeProtocol.Parse(Encoding.UTF8.GetBytes(json)));
    }

    [Fact]
    public void RejectsFramesLargerThan64KiB()
    {
        Assert.Throws<BridgeProtocolException>(() => BridgeProtocol.Parse(new byte[65_537]));
    }

    [Fact]
    public void SerializesOnlyFixedPluginOperations()
    {
        Assert.Equal(
            "{\"version\":1,\"type\":\"prompt\",\"requestId\":\"r\",\"text\":\"hello\"}",
            Encoding.UTF8.GetString(BridgeProtocol.Prompt("r", "hello")));
        Assert.Equal(
            "{\"version\":1,\"type\":\"abort\",\"requestId\":\"r\"}",
            Encoding.UTF8.GetString(BridgeProtocol.Abort("r")));
        Assert.Equal(
            "{\"version\":1,\"type\":\"get_status\"}",
            Encoding.UTF8.GetString(BridgeProtocol.GetStatus()));
        Assert.Equal(
            "{\"version\":1,\"type\":\"new_session\"}",
            Encoding.UTF8.GetString(BridgeProtocol.NewSession()));
        Assert.Equal(
            "{\"version\":1,\"type\":\"select_model\",\"preset\":\"luna\"}",
            Encoding.UTF8.GetString(BridgeProtocol.SelectModel("luna")));
        Assert.Equal(
            "{\"version\":1,\"type\":\"set_thinking_level\",\"level\":\"off\"}",
            Encoding.UTF8.GetString(BridgeProtocol.SetThinkingLevel("off")));
    }

    [Fact]
    public void ReconnectBackoffIsCappedAtThirtySeconds()
    {
        Assert.Equal(TimeSpan.FromSeconds(1), ReconnectBackoff.ForAttempt(0));
        Assert.Equal(TimeSpan.FromSeconds(2), ReconnectBackoff.ForAttempt(1));
        Assert.Equal(TimeSpan.FromSeconds(16), ReconnectBackoff.ForAttempt(4));
        Assert.Equal(TimeSpan.FromSeconds(30), ReconnectBackoff.ForAttempt(5));
        Assert.Equal(TimeSpan.FromSeconds(30), ReconnectBackoff.ForAttempt(20));
    }
}
