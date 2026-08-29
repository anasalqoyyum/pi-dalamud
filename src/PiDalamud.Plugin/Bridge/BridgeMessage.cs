using System.Buffers;
using System.Text.Json;

namespace PiDalamud.Plugin.Bridge;

public abstract record BridgeEvent;

public sealed record ConnectingEvent(int Attempt) : BridgeEvent;

public sealed record DisconnectedEvent(string Message) : BridgeEvent;

public sealed record ProtocolFailureEvent(string Message) : BridgeEvent;

public sealed record ReadyEvent(string SessionId) : BridgeEvent;

public sealed record AcceptedEvent(string RequestId) : BridgeEvent;

public sealed record SettledEvent(string RequestId, string SessionId, string Text) : BridgeEvent;

public sealed record StatusEvent(
    BridgeRuntimeState State,
    string SessionId,
    string? ActiveRequestId) : BridgeEvent;

public sealed record AbortedEvent(string RequestId) : BridgeEvent;

public sealed record BridgeErrorEvent(string Code, string Message, string? RequestId) : BridgeEvent;

public static class BridgeProtocol
{
    public const int MaxFrameBytes = 64 * 1024;

    public static BridgeEvent Parse(ReadOnlyMemory<byte> utf8)
    {
        if (utf8.Length > MaxFrameBytes)
        {
            throw new BridgeProtocolException("Bridge message exceeds 64 KiB");
        }

        try
        {
            using var document = JsonDocument.Parse(utf8);
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object ||
                !root.TryGetProperty("version", out var version) ||
                version.ValueKind != JsonValueKind.Number ||
                !version.TryGetInt32(out var protocolVersion) ||
                protocolVersion != 1)
            {
                throw new BridgeProtocolException("Bridge message has an unsupported version");
            }

            var type = RequiredString(root, "type");
            return type switch
            {
                "ready" => ParseReady(root),
                "accepted" => ParseAccepted(root),
                "settled" => ParseSettled(root),
                "status" => ParseStatus(root),
                "aborted" => ParseAborted(root),
                "error" => ParseError(root),
                _ => throw new BridgeProtocolException("Bridge message type is unknown"),
            };
        }
        catch (BridgeProtocolException)
        {
            throw;
        }
        catch (Exception error) when (error is JsonException or InvalidOperationException)
        {
            throw new BridgeProtocolException("Bridge message is malformed", error);
        }
    }

    public static byte[] Prompt(string requestId, string text) => WriteMessage(writer =>
    {
        WriteEnvelope(writer, "prompt");
        writer.WriteString("requestId", requestId);
        writer.WriteString("text", text);
    });

    public static byte[] Abort(string requestId) => WriteMessage(writer =>
    {
        WriteEnvelope(writer, "abort");
        writer.WriteString("requestId", requestId);
    });

    public static byte[] GetStatus() => WriteMessage(writer => WriteEnvelope(writer, "get_status"));

    public static byte[] NewSession() => WriteMessage(writer => WriteEnvelope(writer, "new_session"));

    private static ReadyEvent ParseReady(JsonElement root)
    {
        RequireExactProperties(root, "version", "type", "sessionId", "state");
        if (RequiredString(root, "state") != "idle")
        {
            throw new BridgeProtocolException("Ready message state is invalid");
        }

        return new ReadyEvent(RequiredString(root, "sessionId"));
    }

    private static AcceptedEvent ParseAccepted(JsonElement root)
    {
        RequireExactProperties(root, "version", "type", "requestId");
        return new AcceptedEvent(RequiredString(root, "requestId"));
    }

    private static SettledEvent ParseSettled(JsonElement root)
    {
        RequireExactProperties(root, "version", "type", "requestId", "sessionId", "text");
        return new SettledEvent(
            RequiredString(root, "requestId"),
            RequiredString(root, "sessionId"),
            RequiredString(root, "text", allowEmpty: true));
    }

    private static StatusEvent ParseStatus(JsonElement root)
    {
        RequireExactProperties(root, ["activeRequestId"], "version", "type", "state", "sessionId");
        var activeRequestId = root.TryGetProperty("activeRequestId", out var active)
            ? ElementString(active, "activeRequestId")
            : null;
        return new StatusEvent(
            ParseState(RequiredString(root, "state")),
            RequiredString(root, "sessionId"),
            activeRequestId);
    }

    private static AbortedEvent ParseAborted(JsonElement root)
    {
        RequireExactProperties(root, "version", "type", "requestId");
        return new AbortedEvent(RequiredString(root, "requestId"));
    }

    private static BridgeErrorEvent ParseError(JsonElement root)
    {
        RequireExactProperties(root, ["requestId"], "version", "type", "code", "message");
        var requestId = root.TryGetProperty("requestId", out var request)
            ? ElementString(request, "requestId")
            : null;
        return new BridgeErrorEvent(
            RequiredString(root, "code"),
            RequiredString(root, "message"),
            requestId);
    }

    private static BridgeRuntimeState ParseState(string state) => state switch
    {
        "starting" => BridgeRuntimeState.Starting,
        "idle" => BridgeRuntimeState.Idle,
        "running" => BridgeRuntimeState.Running,
        "error" => BridgeRuntimeState.Error,
        _ => throw new BridgeProtocolException("Bridge state is unknown"),
    };

    private static string RequiredString(JsonElement root, string propertyName, bool allowEmpty = false)
    {
        if (!root.TryGetProperty(propertyName, out var property))
        {
            throw new BridgeProtocolException($"Bridge message is missing {propertyName}");
        }

        return ElementString(property, propertyName, allowEmpty);
    }

    private static string ElementString(JsonElement property, string propertyName, bool allowEmpty = false)
    {
        if (property.ValueKind != JsonValueKind.String)
        {
            throw new BridgeProtocolException($"Bridge message {propertyName} is not a string");
        }

        var value = property.GetString();
        if (value is null || (!allowEmpty && value.Length == 0))
        {
            throw new BridgeProtocolException($"Bridge message {propertyName} is empty");
        }

        return value;
    }

    private static void RequireExactProperties(JsonElement root, params string[] required) =>
        RequireExactProperties(root, [], required);

    private static void RequireExactProperties(
        JsonElement root,
        IReadOnlyCollection<string> optional,
        params string[] required)
    {
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var property in root.EnumerateObject())
        {
            if (!seen.Add(property.Name))
            {
                throw new BridgeProtocolException("Bridge message contains a duplicate field");
            }

            if (!required.Contains(property.Name, StringComparer.Ordinal) &&
                !optional.Contains(property.Name, StringComparer.Ordinal))
            {
                throw new BridgeProtocolException("Bridge message contains an unknown field");
            }
        }

        if (required.Any(name => !seen.Contains(name)))
        {
            throw new BridgeProtocolException("Bridge message is missing a required field");
        }
    }

    private static byte[] WriteMessage(Action<Utf8JsonWriter> writeFields)
    {
        var buffer = new ArrayBufferWriter<byte>();
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartObject();
            writeFields(writer);
            writer.WriteEndObject();
        }

        return buffer.WrittenSpan.ToArray();
    }

    private static void WriteEnvelope(Utf8JsonWriter writer, string type)
    {
        writer.WriteNumber("version", 1);
        writer.WriteString("type", type);
    }
}

public sealed class BridgeProtocolException(string message, Exception? innerException = null)
    : Exception(message, innerException);
