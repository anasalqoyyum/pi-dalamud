using System.Collections.Concurrent;
using Dalamud.Game.Command;
using Dalamud.Interface.Windowing;
using Dalamud.IoC;
using Dalamud.Plugin;
using Dalamud.Plugin.Services;
using PiDalamud.Plugin.Bridge;
using PiDalamud.Plugin.Windows;

namespace PiDalamud.Plugin;

public sealed class Plugin : IDalamudPlugin
{
    private const string CommandName = "/pi";
    private const int EventsPerFrame = 64;

    [PluginService]
    internal static IDalamudPluginInterface PluginInterface { get; private set; } = null!;

    [PluginService]
    internal static ICommandManager CommandManager { get; private set; } = null!;

    [PluginService]
    internal static IChatGui ChatGui { get; private set; } = null!;

    [PluginService]
    internal static IFramework Framework { get; private set; } = null!;

    [PluginService]
    internal static IPluginLog Log { get; private set; } = null!;

    private readonly ConcurrentQueue<BridgeEvent> bridgeEvents = new();
    private readonly ChatModel model = new();
    private readonly WindowSystem windowSystem = new("PiDalamud");
    private readonly PiChatWindow chatWindow;
    private readonly ConfigWindow configWindow;
    private BridgeClient? bridgeClient;
    private bool statusNoticeRequested;
    private bool disposed;

    public Plugin()
    {
        Configuration = PluginInterface.GetPluginConfig() as Configuration ?? new Configuration();
        chatWindow = new PiChatWindow(
            model,
            SendPrompt,
            StopActiveRequest,
            StartNewSession,
            OpenConfigUi);
        configWindow = new ConfigWindow(Configuration, SaveAndReconnect);
        windowSystem.AddWindow(chatWindow);
        windowSystem.AddWindow(configWindow);

        CommandManager.AddHandler(CommandName, new CommandInfo(OnCommand)
        {
            HelpMessage = "Open Pi chat or use /pi <prompt>, stop, status, or new.",
        });
        PluginInterface.UiBuilder.Draw += windowSystem.Draw;
        PluginInterface.UiBuilder.OpenMainUi += OpenMainUi;
        PluginInterface.UiBuilder.OpenConfigUi += OpenConfigUi;
        Framework.Update += OnFrameworkUpdate;
        StartBridgeClient();
    }

    public Configuration Configuration { get; }

    public void Dispose()
    {
        if (disposed)
        {
            return;
        }

        disposed = true;
        bridgeClient?.Dispose();
        bridgeClient = null;
        Framework.Update -= OnFrameworkUpdate;
        PluginInterface.UiBuilder.Draw -= windowSystem.Draw;
        PluginInterface.UiBuilder.OpenMainUi -= OpenMainUi;
        PluginInterface.UiBuilder.OpenConfigUi -= OpenConfigUi;
        CommandManager.RemoveHandler(CommandName);
        windowSystem.RemoveAllWindows();
        chatWindow.Dispose();
        configWindow.Dispose();
    }

    private void OnCommand(string command, string arguments)
    {
        var parsed = CommandParser.Parse(arguments);
        switch (parsed.Kind)
        {
            case PiCommandKind.Open:
                OpenMainUi();
                break;
            case PiCommandKind.Stop:
                StopActiveRequest();
                break;
            case PiCommandKind.Status:
                RequestStatus();
                break;
            case PiCommandKind.NewSession:
                chatWindow.RequestNewSessionConfirmation();
                break;
            case PiCommandKind.Prompt:
                OpenMainUi();
                if (parsed.Prompt is not null)
                {
                    SendPrompt(parsed.Prompt);
                }

                break;
        }
    }

    private bool SendPrompt(string prompt)
    {
        var requestId = Guid.NewGuid().ToString();
        if (!model.TryBeginPrompt(requestId, prompt))
        {
            ChatGui.PrintError("Pi is not ready or the prompt is outside the 1 to 16,000 character limit.", "Pi");
            return false;
        }

        if (bridgeClient?.TrySendPrompt(requestId, prompt.Trim()) == true)
        {
            return true;
        }

        model.FailQueuedPrompt(requestId);
        ChatGui.PrintError("Bridge is unavailable.", "Pi");
        return false;
    }

    private void StopActiveRequest()
    {
        var requestId = model.ActiveRequestId;
        if (requestId is null || bridgeClient?.TryAbort(requestId) != true)
        {
            ChatGui.PrintError("No active Pi request.", "Pi");
        }
    }

    private void RequestStatus()
    {
        statusNoticeRequested = true;
        if (bridgeClient?.TryGetStatus() != true)
        {
            statusNoticeRequested = false;
            ChatGui.Print("Bridge disconnected.", "Pi");
        }
    }

    private bool StartNewSession()
    {
        if (!model.TryBeginNewSession())
        {
            ChatGui.PrintError("Stop the active request before starting a new session.", "Pi");
            return false;
        }

        if (bridgeClient?.TryNewSession() == true)
        {
            return true;
        }

        model.CancelNewSessionRequest();
        ChatGui.PrintError("Bridge is unavailable.", "Pi");
        return false;
    }

    private void OnFrameworkUpdate(IFramework framework)
    {
        for (var count = 0; count < EventsPerFrame && bridgeEvents.TryDequeue(out var bridgeEvent); count++)
        {
            model.Apply(bridgeEvent);
            switch (bridgeEvent)
            {
                case AcceptedEvent:
                    ChatGui.Print("Working...", "Pi");
                    break;
                case SettledEvent:
                    ChatGui.Print("Response received. Use /pi to view.", "Pi");
                    break;
                case StatusEvent when statusNoticeRequested:
                    statusNoticeRequested = false;
                    ChatGui.Print(model.StatusLine, "Pi");
                    break;
                case DisconnectedEvent or ProtocolFailureEvent:
                    statusNoticeRequested = false;
                    break;
                case BridgeErrorEvent error:
                    ChatGui.PrintError($"{error.Code}: {error.Message}", "Pi");
                    break;
            }
        }
    }

    private void SaveAndReconnect()
    {
        PluginInterface.SavePluginConfig(Configuration);
        StartBridgeClient();
    }

    private void StartBridgeClient()
    {
        bridgeClient?.Dispose();
        bridgeClient = null;
        bridgeEvents.Clear();
        if (!Configuration.TryGetConnection(out var endpoint, out var error) || endpoint is null)
        {
            model.Apply(new DisconnectedEvent(error));
            return;
        }

        bridgeClient = new BridgeClient(
            endpoint,
            Configuration.BearerToken,
            bridgeEvents,
            (code, exception) => Log.Warning(exception, "Bridge client event {Code}", code));
        bridgeClient.Start();
    }

    private void OpenMainUi() => chatWindow.OpenAndFocus();

    private void OpenConfigUi()
    {
        configWindow.IsOpen = true;
        configWindow.BringToFront();
    }
}
