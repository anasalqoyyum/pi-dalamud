using System.Numerics;
using Dalamud.Bindings.ImGui;
using Dalamud.Interface.Windowing;
using PiDalamud.Plugin.Bridge;

namespace PiDalamud.Plugin.Windows;

public sealed class PiChatWindow : Window, IDisposable
{
    private readonly ChatModel model;
    private readonly Func<string, bool> sendPrompt;
    private readonly Action stop;
    private readonly Func<bool> newSession;
    private readonly Action openConfiguration;
    private string prompt = string.Empty;
    private int displayedTranscriptCount;
    private bool newSessionModalOpen;
    private bool openNewSessionModal;

    public PiChatWindow(
        ChatModel model,
        Func<string, bool> sendPrompt,
        Action stop,
        Func<bool> newSession,
        Action openConfiguration)
        : base("Pi Chat###PiDalamudChat", ImGuiWindowFlags.NoScrollbar | ImGuiWindowFlags.NoScrollWithMouse)
    {
        this.model = model;
        this.sendPrompt = sendPrompt;
        this.stop = stop;
        this.newSession = newSession;
        this.openConfiguration = openConfiguration;
        Size = new Vector2(620, 640);
        SizeCondition = ImGuiCond.FirstUseEver;
        SizeConstraints = new WindowSizeConstraints
        {
            MinimumSize = new Vector2(440, 420),
            MaximumSize = new Vector2(float.MaxValue, float.MaxValue),
        };
    }

    public void Dispose()
    {
    }

    public void OpenAndFocus()
    {
        IsOpen = true;
        BringToFront();
    }

    public void RequestNewSessionConfirmation()
    {
        OpenAndFocus();
        openNewSessionModal = true;
    }

    public override void Draw()
    {
        DrawConnectionStatus();
        ImGui.Separator();
        DrawTranscript();
        ImGui.Spacing();
        ImGui.InputTextMultiline("##PiPrompt"u8, ref prompt, 65_537, new Vector2(-1, 86));
        DrawActions();
        ImGui.TextUnformatted(model.StatusLine);
        DrawNewSessionModal();
    }

    private void DrawConnectionStatus()
    {
        var color = model.ConnectionState switch
        {
            BridgeConnectionState.Disconnected => new Vector4(0.65f, 0.65f, 0.65f, 1),
            BridgeConnectionState.Connecting => new Vector4(0.95f, 0.75f, 0.25f, 1),
            BridgeConnectionState.Idle => new Vector4(0.35f, 0.85f, 0.45f, 1),
            BridgeConnectionState.Running => new Vector4(0.35f, 0.7f, 1, 1),
            BridgeConnectionState.Error => new Vector4(1, 0.35f, 0.35f, 1),
            _ => Vector4.One,
        };
        ImGui.TextColored(color, model.ConnectionState.ToString());
        if (model.SessionId is not null)
        {
            ImGui.SameLine();
            ImGui.TextDisabled($"Session {model.SessionId}");
        }
    }

    private void DrawTranscript()
    {
        if (ImGui.BeginChild("PiTranscript"u8, new Vector2(0, -155), true))
        {
            foreach (var entry in model.Transcript)
            {
                ImGui.PushStyleColor(ImGuiCol.Text, RoleColor(entry.Role));
                ImGui.TextUnformatted(RoleName(entry.Role));
                ImGui.PopStyleColor();
                ImGui.SameLine();
                ImGui.TextDisabled(entry.TimestampUtc.ToLocalTime().ToString("HH:mm"));
                ImGui.PushTextWrapPos(0);
                ImGui.TextUnformatted(entry.Text);
                ImGui.PopTextWrapPos();
                ImGui.Spacing();
            }

            if (displayedTranscriptCount != model.Transcript.Count)
            {
                ImGui.SetScrollHereY(1);
                displayedTranscriptCount = model.Transcript.Count;
            }
        }

        ImGui.EndChild();
    }

    private void DrawActions()
    {
        ImGui.BeginDisabled(!model.CanSend || string.IsNullOrWhiteSpace(prompt));
        if (ImGui.Button("Send"u8) && sendPrompt(prompt))
        {
            prompt = string.Empty;
        }

        ImGui.EndDisabled();
        ImGui.SameLine();
        ImGui.BeginDisabled(!model.CanStop);
        if (ImGui.Button("Stop"u8))
        {
            stop();
        }

        ImGui.EndDisabled();
        ImGui.SameLine();
        ImGui.BeginDisabled(!model.CanSend);
        if (ImGui.Button("New session"u8))
        {
            openNewSessionModal = true;
        }

        ImGui.EndDisabled();
        ImGui.SameLine();
        if (ImGui.Button("Settings"u8))
        {
            openConfiguration();
        }
    }

    private void DrawNewSessionModal()
    {
        const string title = "Start a new Pi session?";
        if (openNewSessionModal)
        {
            ImGui.OpenPopup(title);
            newSessionModalOpen = true;
            openNewSessionModal = false;
        }

        if (!ImGui.BeginPopupModal(title, ref newSessionModalOpen, ImGuiWindowFlags.AlwaysAutoResize))
        {
            return;
        }

        ImGui.TextUnformatted("The in-game transcript will be cleared after Pi creates the session.");
        if (ImGui.Button("Create session"u8))
        {
            if (newSession())
            {
                newSessionModalOpen = false;
                ImGui.CloseCurrentPopup();
            }
        }

        ImGui.SameLine();
        if (ImGui.Button("Cancel"u8))
        {
            newSessionModalOpen = false;
            ImGui.CloseCurrentPopup();
        }

        ImGui.EndPopup();
    }

    private static Vector4 RoleColor(TranscriptRole role) => role switch
    {
        TranscriptRole.User => new Vector4(0.4f, 0.75f, 1, 1),
        TranscriptRole.Assistant => new Vector4(0.5f, 0.9f, 0.55f, 1),
        TranscriptRole.System => new Vector4(0.75f, 0.75f, 0.75f, 1),
        TranscriptRole.Error => new Vector4(1, 0.4f, 0.4f, 1),
        _ => Vector4.One,
    };

    private static string RoleName(TranscriptRole role) => role switch
    {
        TranscriptRole.User => "You",
        TranscriptRole.Assistant => "Pi",
        TranscriptRole.System => "System",
        TranscriptRole.Error => "Error",
        _ => "Unknown",
    };
}
