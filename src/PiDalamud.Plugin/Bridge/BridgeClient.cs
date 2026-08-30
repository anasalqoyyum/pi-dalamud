using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Threading.Channels;

namespace PiDalamud.Plugin.Bridge;

public sealed class BridgeClient : IDisposable
{
    private readonly Uri endpoint;
    private readonly string token;
    private readonly ConcurrentQueue<BridgeEvent> events;
    private readonly Action<string, Exception?> log;
    private readonly CancellationTokenSource cancellation = new();
    private readonly Channel<ReadOnlyMemory<byte>> outgoing = Channel.CreateUnbounded<ReadOnlyMemory<byte>>(
        new UnboundedChannelOptions { SingleReader = true, SingleWriter = false });
    private ClientWebSocket? socket;
    private int started;
    private int disposed;
    private int ready;

    public BridgeClient(
        Uri endpoint,
        string token,
        ConcurrentQueue<BridgeEvent> events,
        Action<string, Exception?>? log = null)
    {
        if (endpoint.Scheme != "ws" || endpoint.Host != "127.0.0.1")
        {
            throw new ArgumentException("Bridge endpoint must use ws://127.0.0.1", nameof(endpoint));
        }

        ArgumentException.ThrowIfNullOrWhiteSpace(token);
        this.endpoint = endpoint;
        this.token = token;
        this.events = events;
        this.log = log ?? ((_, _) => { });
    }

    public Task Completion { get; private set; } = Task.CompletedTask;

    public void Start()
    {
        ObjectDisposedException.ThrowIf(Volatile.Read(ref disposed) != 0, this);
        if (Interlocked.Exchange(ref started, 1) != 0)
        {
            throw new InvalidOperationException("Bridge client has already started");
        }

        Completion = Task.Run(ConnectionLoopAsync);
    }

    public bool TrySendPrompt(string requestId, string text) =>
        TryQueue(BridgeProtocol.Prompt(requestId, text));

    public bool TryAbort(string requestId) => TryQueue(BridgeProtocol.Abort(requestId));

    public bool TryGetStatus() => TryQueue(BridgeProtocol.GetStatus());

    public bool TryNewSession() => TryQueue(BridgeProtocol.NewSession());

    public bool TrySelectModel(string preset) => TryQueue(BridgeProtocol.SelectModel(preset));

    public bool TrySetThinkingLevel(string level) => TryQueue(BridgeProtocol.SetThinkingLevel(level));

    public void Dispose()
    {
        if (Interlocked.Exchange(ref disposed, 1) != 0)
        {
            return;
        }

        cancellation.Cancel();
        Volatile.Write(ref ready, 0);
        outgoing.Writer.TryComplete();
        var activeSocket = Volatile.Read(ref socket);
        if (activeSocket is not { State: WebSocketState.Open })
        {
            activeSocket?.Abort();
            return;
        }

        _ = Task.Run(async () =>
        {
            try
            {
                using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(1));
                await activeSocket.CloseAsync(
                    WebSocketCloseStatus.NormalClosure,
                    "Plugin unloaded",
                    timeout.Token).ConfigureAwait(false);
            }
            catch (Exception error) when (error is WebSocketException or OperationCanceledException)
            {
                activeSocket.Abort();
            }
        });
    }

    private bool TryQueue(ReadOnlyMemory<byte> message) =>
        Volatile.Read(ref disposed) == 0 &&
        Volatile.Read(ref ready) != 0 &&
        outgoing.Writer.TryWrite(message);

    private async Task ConnectionLoopAsync()
    {
        var attempt = 0;
        while (!cancellation.IsCancellationRequested)
        {
            events.Enqueue(new ConnectingEvent(attempt));
            var connected = false;
            try
            {
                await RunConnectionAsync(() => connected = true, cancellation.Token).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (cancellation.IsCancellationRequested)
            {
                break;
            }
            catch (BridgeProtocolException error)
            {
                log("invalid_message", error);
                events.Enqueue(new ProtocolFailureEvent("Bridge returned invalid data"));
            }
            catch (Exception error) when (error is WebSocketException or IOException)
            {
                log("bridge_unavailable", error);
                events.Enqueue(new DisconnectedEvent("Bridge unavailable or authentication failed"));
            }

            if (cancellation.IsCancellationRequested)
            {
                break;
            }

            var delayAttempt = connected ? 0 : attempt;
            try
            {
                await Task.Delay(ReconnectBackoff.ForAttempt(delayAttempt), cancellation.Token)
                    .ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (cancellation.IsCancellationRequested)
            {
                break;
            }

            attempt = connected ? 0 : Math.Min(attempt + 1, 5);
        }
    }

    private async Task RunConnectionAsync(Action connected, CancellationToken cancellationToken)
    {
        using var client = new ClientWebSocket();
        Volatile.Write(ref ready, 0);
        client.Options.SetRequestHeader("Authorization", $"Bearer {token}");
        Volatile.Write(ref socket, client);

        try
        {
            await client.ConnectAsync(endpoint, cancellationToken).ConfigureAwait(false);
            connected();
            await client.SendAsync(
                BridgeProtocol.GetStatus(),
                WebSocketMessageType.Text,
                true,
                cancellationToken).ConfigureAwait(false);

            using var connectionCancellation = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            var receiveTask = ReceiveLoopAsync(client, connectionCancellation.Token);
            var sendTask = SendLoopAsync(client, connectionCancellation.Token);
            var completed = await Task.WhenAny(receiveTask, sendTask).ConfigureAwait(false);
            await connectionCancellation.CancelAsync().ConfigureAwait(false);
            client.Abort();
            await completed.ConfigureAwait(false);
            await Task.WhenAll(receiveTask, sendTask).ConfigureAwait(false);
        }
        finally
        {
            Volatile.Write(ref ready, 0);
            Interlocked.CompareExchange(ref socket, null, client);
        }
    }

    private async Task SendLoopAsync(ClientWebSocket client, CancellationToken cancellationToken)
    {
        await foreach (var message in outgoing.Reader.ReadAllAsync(cancellationToken).ConfigureAwait(false))
        {
            await client.SendAsync(
                message,
                WebSocketMessageType.Text,
                true,
                cancellationToken).ConfigureAwait(false);
        }
    }

    private async Task ReceiveLoopAsync(ClientWebSocket client, CancellationToken cancellationToken)
    {
        var receiveBuffer = new byte[8192];
        using var frame = new MemoryStream();
        var statusReceived = false;

        while (true)
        {
            var result = await client.ReceiveAsync(receiveBuffer, cancellationToken).ConfigureAwait(false);
            if (result.MessageType == WebSocketMessageType.Close)
            {
                throw new WebSocketException("Bridge closed the connection");
            }

            if (result.MessageType != WebSocketMessageType.Text)
            {
                throw new BridgeProtocolException("Bridge returned a binary frame");
            }

            if (frame.Length + result.Count > BridgeProtocol.MaxFrameBytes)
            {
                throw new BridgeProtocolException("Bridge message exceeds 64 KiB");
            }

            frame.Write(receiveBuffer, 0, result.Count);
            if (!result.EndOfMessage)
            {
                continue;
            }

            var bridgeEvent = BridgeProtocol.Parse(frame.ToArray());
            frame.SetLength(0);
            if (bridgeEvent is StatusEvent)
            {
                statusReceived = true;
                Volatile.Write(ref ready, 1);
            }

            if (statusReceived || bridgeEvent is not ReadyEvent)
            {
                events.Enqueue(bridgeEvent);
            }
        }
    }
}
