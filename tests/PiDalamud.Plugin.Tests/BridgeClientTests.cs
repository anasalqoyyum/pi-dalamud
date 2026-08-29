using System.Collections.Concurrent;
using System.Net;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using PiDalamud.Plugin.Bridge;

namespace PiDalamud.Plugin.Tests;

public sealed class BridgeClientTests
{
    [Fact]
    public async Task ConnectsAuthenticatesAndReceivesCompletedResponse()
    {
        await using var server = await TestWebSocketServer.StartAsync("pairing-token");
        var events = new ConcurrentQueue<BridgeEvent>();
        using var client = new BridgeClient(server.WebSocketUri, "pairing-token", events);
        client.Start();

        await server.Connected.WaitAsync(TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken);
        Assert.Equal("Bearer pairing-token", server.Authorization);
        Assert.Equal("get_status", await server.ReceiveTypeAsync());
        await server.SendAsync("""{"version":1,"type":"ready","sessionId":"session-1","state":"idle"}""");
        await server.SendAsync("""{"version":1,"type":"status","state":"idle","sessionId":"session-1"}""");
        await WaitForEventAsync<StatusEvent>(events);

        Assert.True(client.TrySendPrompt("request-1", "hello"));
        Assert.Equal("prompt", await server.ReceiveTypeAsync());
        await server.SendAsync("""{"version":1,"type":"accepted","requestId":"request-1"}""");
        await server.SendAsync("""{"version":1,"type":"settled","requestId":"request-1","sessionId":"session-1","text":"complete"}""");

        Assert.Equal(new AcceptedEvent("request-1"), await WaitForEventAsync<AcceptedEvent>(events));
        Assert.Equal(
            new SettledEvent("request-1", "session-1", "complete"),
            await WaitForEventAsync<SettledEvent>(events));
    }

    [Fact]
    public async Task ReportsAuthenticationFailureAndDisposesWithoutBlocking()
    {
        await using var server = await TestWebSocketServer.StartAsync("right-token", rejectUnauthorized: true);
        var events = new ConcurrentQueue<BridgeEvent>();
        using var client = new BridgeClient(server.WebSocketUri, "wrong-token", events);
        client.Start();

        var disconnected = await WaitForEventAsync<DisconnectedEvent>(events);
        Assert.Contains("unavailable", disconnected.Message, StringComparison.OrdinalIgnoreCase);

        var started = DateTime.UtcNow;
        client.Dispose();
        Assert.True(DateTime.UtcNow - started < TimeSpan.FromMilliseconds(100));
        await client.Completion.WaitAsync(TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken);
    }

    [Fact]
    public async Task RejectsMalformedBridgeJsonAndCancelsOnDispose()
    {
        await using var server = await TestWebSocketServer.StartAsync("token");
        var events = new ConcurrentQueue<BridgeEvent>();
        using var client = new BridgeClient(server.WebSocketUri, "token", events);
        client.Start();
        await server.Connected.WaitAsync(TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken);
        await server.ReceiveTypeAsync();
        await server.SendAsync("{bad}");

        await WaitForEventAsync<ProtocolFailureEvent>(events);
        client.Dispose();
        await client.Completion.WaitAsync(TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken);
    }

    [Fact]
    public async Task ReconnectsAndRequestsStatusBeforePublishingReady()
    {
        await using var server = await TestWebSocketServer.StartAsync("token");
        var events = new ConcurrentQueue<BridgeEvent>();
        using var client = new BridgeClient(server.WebSocketUri, "token", events);
        client.Start();
        await server.Connected.WaitAsync(TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken);
        await server.ReceiveTypeAsync();
        await server.SendAsync("""{"version":1,"type":"status","state":"idle","sessionId":"session-1"}""");
        await WaitForEventAsync<StatusEvent>(events);

        var reconnected = server.DisconnectAndAcceptNext();
        await WaitForEventAsync<DisconnectedEvent>(events);
        await reconnected.WaitAsync(TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken);
        Assert.Equal("get_status", await server.ReceiveTypeAsync());
        await server.SendAsync("""{"version":1,"type":"ready","sessionId":"session-1","state":"idle"}""");
        await Task.Delay(50, TestContext.Current.CancellationToken);
        Assert.DoesNotContain(events, bridgeEvent => bridgeEvent is ReadyEvent);
        await server.SendAsync("""{"version":1,"type":"status","state":"idle","sessionId":"session-1"}""");

        Assert.Equal(
            new StatusEvent(BridgeRuntimeState.Idle, "session-1", null),
            await WaitForEventAsync<StatusEvent>(events));
    }

    [Fact]
    public async Task MissingBridgeReportsDisconnectedAndRemainsDisposable()
    {
        var port = ReserveUnusedPort();
        var events = new ConcurrentQueue<BridgeEvent>();
        using var client = new BridgeClient(new Uri($"ws://127.0.0.1:{port}/"), "token", events);
        client.Start();

        await WaitForEventAsync<DisconnectedEvent>(events);
        client.Dispose();
        await client.Completion.WaitAsync(TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken);
    }

    [Fact]
    public async Task BridgeLossFailsTheActiveUiRequestAndKeepsTranscript()
    {
        await using var server = await TestWebSocketServer.StartAsync("token");
        var events = new ConcurrentQueue<BridgeEvent>();
        var model = new ChatModel();
        using var client = new BridgeClient(server.WebSocketUri, "token", events);
        client.Start();
        await server.Connected.WaitAsync(TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken);
        await server.ReceiveTypeAsync();
        await server.SendAsync("""{"version":1,"type":"status","state":"idle","sessionId":"session-1"}""");
        model.Apply(await WaitForEventAsync<StatusEvent>(events));
        Assert.True(model.TryBeginPrompt("request-1", "hello"));
        Assert.True(client.TrySendPrompt("request-1", "hello"));
        await server.ReceiveTypeAsync();
        await server.SendAsync("""{"version":1,"type":"accepted","requestId":"request-1"}""");
        model.Apply(await WaitForEventAsync<AcceptedEvent>(events));

        _ = server.DisconnectAndAcceptNext();
        model.Apply(await WaitForEventAsync<DisconnectedEvent>(events));

        Assert.Equal(BridgeConnectionState.Disconnected, model.ConnectionState);
        Assert.Collection(
            model.Transcript,
            entry => Assert.Equal(TranscriptRole.User, entry.Role),
            entry => Assert.Equal(TranscriptRole.Error, entry.Role));
    }

    [Fact]
    public async Task DisposalDuringARequestLeavesNoNetworkCallbacks()
    {
        await using var server = await TestWebSocketServer.StartAsync("token");
        var events = new ConcurrentQueue<BridgeEvent>();
        using var client = new BridgeClient(server.WebSocketUri, "token", events);
        client.Start();
        await server.Connected.WaitAsync(TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken);
        await server.ReceiveTypeAsync();
        await server.SendAsync("""{"version":1,"type":"status","state":"idle","sessionId":"session-1"}""");
        await WaitForEventAsync<StatusEvent>(events);
        Assert.True(client.TrySendPrompt("request-1", "__hang__"));
        await server.ReceiveTypeAsync();
        await server.SendAsync("""{"version":1,"type":"accepted","requestId":"request-1"}""");
        await WaitForEventAsync<AcceptedEvent>(events);

        client.Dispose();
        await client.Completion.WaitAsync(TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken);
        await Task.Delay(100, TestContext.Current.CancellationToken);

        Assert.Empty(events);
    }

    private static int ReserveUnusedPort()
    {
        using var listener = new System.Net.Sockets.TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        return ((IPEndPoint)listener.LocalEndpoint).Port;
    }

    private static async Task<T> WaitForEventAsync<T>(ConcurrentQueue<BridgeEvent> events)
        where T : BridgeEvent
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        while (!timeout.IsCancellationRequested)
        {
            while (events.TryDequeue(out var bridgeEvent))
            {
                if (bridgeEvent is T match)
                {
                    return match;
                }
            }

            await Task.Delay(10, timeout.Token);
        }

        throw new TimeoutException($"No {typeof(T).Name} was received");
    }
}

internal sealed class TestWebSocketServer : IAsyncDisposable
{
    private readonly HttpListener listener;
    private readonly string expectedToken;
    private readonly bool rejectUnauthorized;
    private WebSocket? socket;

    private TestWebSocketServer(HttpListener listener, Uri webSocketUri, string expectedToken, bool rejectUnauthorized)
    {
        this.listener = listener;
        this.expectedToken = expectedToken;
        this.rejectUnauthorized = rejectUnauthorized;
        WebSocketUri = webSocketUri;
    }

    public Uri WebSocketUri { get; }

    public Task Connected { get; private set; } = Task.CompletedTask;

    public string? Authorization { get; private set; }

    public static Task<TestWebSocketServer> StartAsync(string expectedToken, bool rejectUnauthorized = false)
    {
        var port = ReservePort();
        var listener = new HttpListener();
        listener.Prefixes.Add($"http://127.0.0.1:{port}/");
        listener.Start();
        var server = new TestWebSocketServer(
            listener,
            new Uri($"ws://127.0.0.1:{port}/"),
            expectedToken,
            rejectUnauthorized);
        server.Connected = server.AcceptAsync();
        return Task.FromResult(server);
    }

    public async Task<string> ReceiveTypeAsync()
    {
        var webSocket = socket ?? throw new InvalidOperationException("No WebSocket is connected");
        var buffer = new byte[4096];
        var result = await webSocket.ReceiveAsync(buffer, CancellationToken.None);
        using var document = JsonDocument.Parse(buffer.AsMemory(0, result.Count));
        return document.RootElement.GetProperty("type").GetString()
               ?? throw new InvalidOperationException("Message had no type");
    }

    public async Task SendAsync(string json)
    {
        var webSocket = socket ?? throw new InvalidOperationException("No WebSocket is connected");
        await webSocket.SendAsync(
            Encoding.UTF8.GetBytes(json),
            WebSocketMessageType.Text,
            true,
            CancellationToken.None);
    }

    public Task DisconnectAndAcceptNext()
    {
        socket?.Abort();
        socket?.Dispose();
        socket = null;
        Connected = AcceptAsync();
        return Connected;
    }

    public async ValueTask DisposeAsync()
    {
        listener.Close();
        if (socket is not null)
        {
            socket.Abort();
            socket.Dispose();
        }

        try
        {
            await Connected;
        }
        catch (Exception) when (listener.IsListening is false)
        {
        }
    }

    private async Task AcceptAsync()
    {
        var context = await listener.GetContextAsync();
        Authorization = context.Request.Headers["Authorization"];
        if (rejectUnauthorized && Authorization != $"Bearer {expectedToken}")
        {
            context.Response.StatusCode = 401;
            context.Response.Close();
            return;
        }

        var accepted = await context.AcceptWebSocketAsync(null);
        socket = accepted.WebSocket;
    }

    private static int ReservePort()
    {
        using var listener = new System.Net.Sockets.TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        return ((IPEndPoint)listener.LocalEndpoint).Port;
    }
}
