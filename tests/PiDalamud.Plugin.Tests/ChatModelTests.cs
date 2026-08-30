using PiDalamud.Plugin.Bridge;

namespace PiDalamud.Plugin.Tests;

public sealed class ChatModelTests
{
    [Fact]
    public void AppendsUserOnlyAfterAcceptanceAndAssistantAfterSettlement()
    {
        var model = new ChatModel();
        model.Apply(new StatusEvent(BridgeRuntimeState.Idle, "session-1", null));
        Assert.True(model.TryBeginPrompt("request-1", "hello"));
        Assert.Empty(model.Transcript);

        model.Apply(new AcceptedEvent("request-1"));
        Assert.Collection(
            model.Transcript,
            entry =>
            {
                Assert.Equal(TranscriptRole.User, entry.Role);
                Assert.Equal("hello", entry.Text);
            });

        model.Apply(new SettledEvent("request-1", "session-1", "complete"));
        Assert.Equal(BridgeConnectionState.Idle, model.ConnectionState);
        Assert.Collection(
            model.Transcript,
            entry => Assert.Equal(TranscriptRole.User, entry.Role),
            entry =>
            {
                Assert.Equal(TranscriptRole.Assistant, entry.Role);
                Assert.Equal("complete", entry.Text);
            });
    }

    [Fact]
    public void LostConnectionFailsActiveRequestWithoutRemovingTranscript()
    {
        var model = new ChatModel();
        model.Apply(new StatusEvent(BridgeRuntimeState.Idle, "session-1", null));
        model.TryBeginPrompt("request-1", "hello");
        model.Apply(new AcceptedEvent("request-1"));

        model.Apply(new DisconnectedEvent("Bridge unavailable"));

        Assert.Equal(BridgeConnectionState.Disconnected, model.ConnectionState);
        Assert.Null(model.ActiveRequestId);
        Assert.Collection(
            model.Transcript,
            entry => Assert.Equal(TranscriptRole.User, entry.Role),
            entry =>
            {
                Assert.Equal(TranscriptRole.Error, entry.Role);
                Assert.Contains("disconnected", entry.Text, StringComparison.OrdinalIgnoreCase);
            });
    }

    [Fact]
    public void BusyErrorKeepsTheActiveTurnRunning()
    {
        var model = new ChatModel();
        model.Apply(new StatusEvent(BridgeRuntimeState.Running, "session-1", "request-1"));

        model.Apply(new BridgeErrorEvent("busy", "Pi is already running", "request-2"));

        Assert.Equal(BridgeConnectionState.Running, model.ConnectionState);
        Assert.Equal("request-1", model.ActiveRequestId);
    }

    [Fact]
    public void AbortFailureKeepsTheActiveTurnRunning()
    {
        var model = new ChatModel();
        model.Apply(new StatusEvent(BridgeRuntimeState.Running, "session-1", "request-1"));

        model.Apply(new BridgeErrorEvent("pi_abort_failed", "Pi could not abort", "request-1"));

        Assert.Equal(BridgeConnectionState.Running, model.ConnectionState);
        Assert.Equal("request-1", model.ActiveRequestId);
    }

    [Fact]
    public void RejectedPromptReturnsToIdle()
    {
        var model = new ChatModel();
        model.Apply(new StatusEvent(BridgeRuntimeState.Idle, "session-1", null));
        model.TryBeginPrompt("request-1", "hello");

        model.Apply(new BridgeErrorEvent("pi_prompt_failed", "Pi rejected the prompt", "request-1"));

        Assert.Equal(BridgeConnectionState.Idle, model.ConnectionState);
        Assert.True(model.CanSend);
    }

    [Fact]
    public void AppliesModelStateAndKeepsSettingsChangesIdleOnly()
    {
        var model = new ChatModel();
        model.Apply(new StatusEvent(BridgeRuntimeState.Idle, "session-1", null));

        Assert.True(model.TryBeginModelChange());
        Assert.False(model.CanSend);
        model.Apply(new ModelStateEvent(
            "sol",
            "openai-codex",
            "gpt-5.6-sol",
            "high",
            ["off", "minimal", "low", "medium", "high"]));

        Assert.Equal("sol", model.ModelPreset);
        Assert.Equal("openai-codex", model.Provider);
        Assert.Equal("gpt-5.6-sol", model.ModelId);
        Assert.Equal("high", model.ThinkingLevel);
        Assert.Equal(["off", "minimal", "low", "medium", "high"], model.AvailableThinkingLevels);
        Assert.True(model.CanChangeSettings);

        Assert.True(model.TryBeginThinkingLevelChange());
        model.Apply(new BridgeErrorEvent(
            "thinking_level_failed",
            "That thinking level is not available",
            null));

        Assert.Equal(BridgeConnectionState.Idle, model.ConnectionState);
        Assert.True(model.CanChangeSettings);
    }

    [Fact]
    public void MapsConnectionAndRuntimeEventsToUiStates()
    {
        var model = new ChatModel();

        model.Apply(new ConnectingEvent(0));
        Assert.Equal(BridgeConnectionState.Connecting, model.ConnectionState);
        model.Apply(new StatusEvent(BridgeRuntimeState.Running, "session-1", "request-1"));
        Assert.Equal(BridgeConnectionState.Running, model.ConnectionState);
        model.Apply(new AbortedEvent("request-1"));
        Assert.Equal(BridgeConnectionState.Idle, model.ConnectionState);
        model.Apply(new ProtocolFailureEvent("invalid"));
        Assert.Equal(BridgeConnectionState.Error, model.ConnectionState);
    }
}
