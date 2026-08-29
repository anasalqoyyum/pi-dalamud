using System.Numerics;
using Dalamud.Bindings.ImGui;
using Dalamud.Interface.Windowing;

namespace PiDalamud.Plugin.Windows;

public sealed class ConfigWindow : Window, IDisposable
{
    private readonly Configuration configuration;
    private readonly Action saveAndReconnect;
    private string bridgeUrl = string.Empty;
    private string bearerToken = string.Empty;
    private string validationError = string.Empty;

    public ConfigWindow(Configuration configuration, Action saveAndReconnect)
        : base("Pi Chat Settings###PiDalamudConfig", ImGuiWindowFlags.AlwaysAutoResize)
    {
        this.configuration = configuration;
        this.saveAndReconnect = saveAndReconnect;
        Size = new Vector2(520, 190);
        SizeCondition = ImGuiCond.FirstUseEver;
    }

    public void Dispose()
    {
    }

    public override void OnOpen()
    {
        bridgeUrl = configuration.BridgeUrl;
        bearerToken = configuration.BearerToken;
        validationError = string.Empty;
    }

    public override void Draw()
    {
        ImGui.TextUnformatted("Authenticated loopback bridge");
        ImGui.SetNextItemWidth(480);
        ImGui.InputText("Bridge URL"u8, ref bridgeUrl, 256);
        ImGui.SetNextItemWidth(480);
        ImGui.InputText("Bearer token"u8, ref bearerToken, 512, ImGuiInputTextFlags.Password);

        if (validationError.Length > 0)
        {
            ImGui.TextColored(new Vector4(1, 0.35f, 0.35f, 1), validationError);
        }

        if (ImGui.Button("Save and reconnect"u8))
        {
            var previousUrl = configuration.BridgeUrl;
            var previousToken = configuration.BearerToken;
            configuration.BridgeUrl = bridgeUrl.Trim();
            configuration.BearerToken = bearerToken.Trim();
            if (configuration.TryGetConnection(out _, out validationError))
            {
                saveAndReconnect();
                IsOpen = false;
            }
            else
            {
                configuration.BridgeUrl = previousUrl;
                configuration.BearerToken = previousToken;
            }
        }
    }
}
