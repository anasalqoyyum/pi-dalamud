using System.Text;
using PiDalamud.Plugin.Bridge;

namespace PiDalamud.Plugin;

public enum TranscriptRole
{
    User,
    Assistant,
    System,
    Error,
}

public sealed record TranscriptEntry(
    Guid Id,
    TranscriptRole Role,
    string Text,
    DateTime TimestampUtc,
    string? RequestId);

public sealed class ChatModel
{
    private readonly List<TranscriptEntry> transcript = [];
    private PendingPrompt? pendingPrompt;
    private bool newSessionRequested;
    private bool modelChangePending;
    private bool thinkingLevelChangePending;

    public IReadOnlyList<TranscriptEntry> Transcript => transcript;

    public BridgeConnectionState ConnectionState { get; private set; } =
        BridgeConnectionState.Disconnected;

    public string StatusLine { get; private set; } = "Bridge disconnected";

    public string? SessionId { get; private set; }

    public string? ActiveRequestId { get; private set; }

    public string? ModelPreset { get; private set; }

    public string? Provider { get; private set; }

    public string? ModelId { get; private set; }

    public string? ThinkingLevel { get; private set; }

    public IReadOnlyList<string> AvailableThinkingLevels { get; private set; } = [];

    public bool CanSend =>
        ConnectionState == BridgeConnectionState.Idle &&
        pendingPrompt is null &&
        ActiveRequestId is null &&
        !modelChangePending &&
        !thinkingLevelChangePending;

    public bool CanChangeSettings => CanSend;

    public bool CanStop => ActiveRequestId is not null;

    public bool TryBeginPrompt(string requestId, string text)
    {
        var trimmed = text.Trim();
        if (!CanSend || trimmed.Length == 0 || trimmed.EnumerateRunes().Take(16_001).Count() > 16_000)
        {
            return false;
        }

        pendingPrompt = new PendingPrompt(requestId, trimmed);
        StatusLine = "Sending prompt";
        return true;
    }

    public void FailQueuedPrompt(string requestId)
    {
        if (pendingPrompt?.RequestId != requestId)
        {
            return;
        }

        pendingPrompt = null;
        Append(TranscriptRole.Error, "Prompt could not be queued", requestId);
        StatusLine = "Prompt could not be queued";
    }

    public bool TryBeginNewSession()
    {
        if (!CanSend)
        {
            return false;
        }

        newSessionRequested = true;
        StatusLine = "Starting new session";
        return true;
    }

    public void CancelNewSessionRequest()
    {
        newSessionRequested = false;
        StatusLine = ConnectionState == BridgeConnectionState.Idle ? "Ready" : StatusLine;
    }

    public bool TryBeginModelChange()
    {
        if (!CanChangeSettings)
        {
            return false;
        }

        modelChangePending = true;
        StatusLine = "Changing model";
        return true;
    }

    public void FailQueuedModelChange()
    {
        modelChangePending = false;
        StatusLine = ConnectionState == BridgeConnectionState.Idle ? "Ready" : StatusLine;
    }

    public bool TryBeginThinkingLevelChange()
    {
        if (!CanChangeSettings)
        {
            return false;
        }

        thinkingLevelChangePending = true;
        StatusLine = "Changing thinking level";
        return true;
    }

    public void FailQueuedThinkingLevelChange()
    {
        thinkingLevelChangePending = false;
        StatusLine = ConnectionState == BridgeConnectionState.Idle ? "Ready" : StatusLine;
    }

    public void Apply(BridgeEvent bridgeEvent)
    {
        switch (bridgeEvent)
        {
            case ConnectingEvent connecting:
                ConnectionState = BridgeConnectionState.Connecting;
                StatusLine = $"Connecting, attempt {connecting.Attempt + 1}";
                break;
            case DisconnectedEvent disconnected:
                FailActiveRequest("Bridge disconnected during the request");
                newSessionRequested = false;
                ClearPendingChanges();
                ConnectionState = BridgeConnectionState.Disconnected;
                StatusLine = disconnected.Message;
                break;
            case ProtocolFailureEvent protocolFailure:
                FailActiveRequest(protocolFailure.Message);
                newSessionRequested = false;
                ClearPendingChanges();
                ConnectionState = BridgeConnectionState.Error;
                StatusLine = protocolFailure.Message;
                break;
            case ReadyEvent ready:
                if (newSessionRequested)
                {
                    transcript.Clear();
                    newSessionRequested = false;
                }

                SessionId = ready.SessionId;
                ActiveRequestId = null;
                pendingPrompt = null;
                ClearPendingChanges();
                ConnectionState = BridgeConnectionState.Idle;
                StatusLine = "Ready";
                break;
            case AcceptedEvent accepted:
                ApplyAccepted(accepted);
                break;
            case SettledEvent settled:
                ApplySettled(settled);
                break;
            case StatusEvent status:
                ApplyStatus(status);
                break;
            case ModelStateEvent modelState:
                ApplyModelState(modelState);
                break;
            case AbortedEvent aborted:
                if (ActiveRequestId == aborted.RequestId)
                {
                    ActiveRequestId = null;
                    ConnectionState = BridgeConnectionState.Idle;
                    StatusLine = "Request stopped";
                }

                break;
            case BridgeErrorEvent error:
                ApplyError(error);
                break;
        }
    }

    private void ApplyAccepted(AcceptedEvent accepted)
    {
        if (pendingPrompt is not { } prompt || prompt.RequestId != accepted.RequestId)
        {
            return;
        }

        Append(TranscriptRole.User, prompt.Text, prompt.RequestId);
        pendingPrompt = null;
        ActiveRequestId = accepted.RequestId;
        ConnectionState = BridgeConnectionState.Running;
        StatusLine = "Pi is working";
    }

    private void ApplySettled(SettledEvent settled)
    {
        if (ActiveRequestId != settled.RequestId)
        {
            return;
        }

        Append(TranscriptRole.Assistant, settled.Text, settled.RequestId);
        SessionId = settled.SessionId;
        ActiveRequestId = null;
        ConnectionState = BridgeConnectionState.Idle;
        StatusLine = "Response received";
    }

    private void ApplyStatus(StatusEvent status)
    {
        SessionId = status.SessionId;
        ActiveRequestId = status.ActiveRequestId;
        ConnectionState = status.State switch
        {
            BridgeRuntimeState.Starting => BridgeConnectionState.Connecting,
            BridgeRuntimeState.Idle => BridgeConnectionState.Idle,
            BridgeRuntimeState.Running => BridgeConnectionState.Running,
            BridgeRuntimeState.Error => BridgeConnectionState.Error,
            _ => BridgeConnectionState.Error,
        };
        StatusLine = status.State switch
        {
            BridgeRuntimeState.Starting => "Pi is starting",
            BridgeRuntimeState.Idle => "Ready",
            BridgeRuntimeState.Running => "Pi is working",
            BridgeRuntimeState.Error => "Pi is unavailable",
            _ => "Unknown bridge state",
        };
    }

    private void ApplyModelState(ModelStateEvent modelState)
    {
        ModelPreset = modelState.Preset;
        Provider = modelState.Provider;
        ModelId = modelState.ModelId;
        ThinkingLevel = modelState.ThinkingLevel;
        AvailableThinkingLevels = modelState.AvailableThinkingLevels;
        modelChangePending = false;
        thinkingLevelChangePending = false;
        if (ConnectionState == BridgeConnectionState.Idle && ActiveRequestId is null)
        {
            StatusLine = "Ready";
        }
    }

    private void ApplyError(BridgeErrorEvent error)
    {
        Append(TranscriptRole.Error, error.Message, error.RequestId);
        var pendingRequestFailed = pendingPrompt?.RequestId == error.RequestId;
        if (pendingRequestFailed)
        {
            pendingPrompt = null;
        }

        if (error.Code == "session_switch_failed")
        {
            newSessionRequested = false;
        }

        if (error.Code == "model_switch_failed")
        {
            modelChangePending = false;
        }

        if (error.Code == "thinking_level_failed")
        {
            thinkingLevelChangePending = false;
        }

        if (error.Code is
            "busy" or
            "request_not_active" or
            "pi_prompt_failed" or
            "pi_abort_failed" or
            "session_switch_failed" or
            "model_switch_failed" or
            "thinking_level_failed")
        {
            StatusLine = error.Message;
            return;
        }

        if (pendingRequestFailed || error.RequestId is null || ActiveRequestId == error.RequestId)
        {
            ActiveRequestId = null;
            ConnectionState = BridgeConnectionState.Error;
        }

        StatusLine = error.Message;
    }

    private void FailActiveRequest(string message)
    {
        var requestId = ActiveRequestId ?? pendingPrompt?.RequestId;
        if (requestId is not null)
        {
            Append(TranscriptRole.Error, message, requestId);
        }

        ActiveRequestId = null;
        pendingPrompt = null;
    }

    private void ClearPendingChanges()
    {
        modelChangePending = false;
        thinkingLevelChangePending = false;
    }

    private void Append(TranscriptRole role, string text, string? requestId) =>
        transcript.Add(new TranscriptEntry(Guid.NewGuid(), role, text, DateTime.UtcNow, requestId));

    private sealed record PendingPrompt(string RequestId, string Text);
}
