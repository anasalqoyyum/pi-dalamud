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
    private readonly Func<string, bool> selectModel;
    private readonly Func<string, bool> setThinkingLevel;
    private readonly Action openConfiguration;
    private string prompt = string.Empty;
    private int displayedTranscriptCount;
    private bool newSessionModalOpen;
    private bool openNewSessionModal;
    private bool modelModalOpen;
    private bool openModelModal;
    private string selectedModelPreset = "luna";

    private static readonly ModelOption[] ModelOptions =
    [
        new("luna", "GPT-5.6 Luna", "openai-codex/gpt-5.6-luna", "max"),
        new("sol", "GPT-5.6 Sol", "openai-codex/gpt-5.6-sol", "high"),
    ];

    public PiChatWindow(
        ChatModel model,
        Func<string, bool> sendPrompt,
        Action stop,
        Func<bool> newSession,
        Func<string, bool> selectModel,
        Func<string, bool> setThinkingLevel,
        Action openConfiguration)
        : base("Pi Chat###PiDalamudChat", ImGuiWindowFlags.NoScrollbar | ImGuiWindowFlags.NoScrollWithMouse)
    {
        this.model = model;
        this.sendPrompt = sendPrompt;
        this.stop = stop;
        this.newSession = newSession;
        this.selectModel = selectModel;
        this.setThinkingLevel = setThinkingLevel;
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
        DrawModelControls();
        ImGui.Separator();
        DrawTranscript();
        ImGui.Spacing();
        if (ImGui.InputTextMultiline(
                "##PiPrompt"u8,
                ref prompt,
                65_537,
                new Vector2(-1, 86),
                ImGuiInputTextFlags.EnterReturnsTrue | ImGuiInputTextFlags.CtrlEnterForNewLine))
        {
            SubmitPrompt();
        }

        DrawActions();
        ImGui.TextUnformatted(model.StatusLine);
        DrawNewSessionModal();
        DrawModelModal();
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
        if (ImGui.BeginChild("PiTranscript"u8, new Vector2(0, -205), true))
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

    private void DrawModelControls()
    {
        ImGui.TextDisabled("Model");
        ImGui.SameLine();
        ImGui.TextUnformatted(CurrentModelLabel());
        ImGui.SameLine();
        ImGui.BeginDisabled(!model.CanChangeSettings);
        if (ImGui.Button("Change##PiModel"u8))
        {
            RequestModelSelection();
        }

        ImGui.EndDisabled();

        ImGui.TextDisabled("Thinking");
        ImGui.SameLine();
        if (model.AvailableThinkingLevels.Count == 0)
        {
            ImGui.TextDisabled("Unavailable");
            return;
        }

        ImGui.SetNextItemWidth(180);
        ImGui.BeginDisabled(!model.CanChangeSettings);
        if (ImGui.BeginCombo("##PiThinkingLevel", FormatThinkingLevel(model.ThinkingLevel)))
        {
            foreach (var level in model.AvailableThinkingLevels)
            {
                var selected = model.ThinkingLevel == level;
                if (ImGui.Selectable($"{FormatThinkingLevel(level)}##{level}", selected) && !selected)
                {
                    setThinkingLevel(level);
                }
            }

            ImGui.EndCombo();
        }

        ImGui.EndDisabled();
    }

    private void DrawActions()
    {
        ImGui.BeginDisabled(!model.CanSend || string.IsNullOrWhiteSpace(prompt));
        if (ImGui.Button("Send"u8))
        {
            SubmitPrompt();
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

    private void SubmitPrompt()
    {
        if (!model.CanSend || string.IsNullOrWhiteSpace(prompt))
        {
            return;
        }

        if (sendPrompt(prompt))
        {
            prompt = string.Empty;
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

    private void RequestModelSelection()
    {
        OpenAndFocus();
        selectedModelPreset = IsKnownModelPreset(model.ModelPreset)
            ? model.ModelPreset!
            : ModelOptions[0].Preset;
        openModelModal = true;
    }

    private void DrawModelModal()
    {
        const string title = "Select a Pi model###PiModelSelector";
        if (openModelModal)
        {
            ImGui.OpenPopup(title);
            modelModalOpen = true;
            openModelModal = false;
        }

        if (!ImGui.BeginPopupModal(title, ref modelModalOpen, ImGuiWindowFlags.AlwaysAutoResize))
        {
            return;
        }

        ImGui.TextUnformatted("Changing the model applies its recommended thinking level.");
        ImGui.Separator();
        foreach (var option in ModelOptions)
        {
            var selected = selectedModelPreset == option.Preset;
            if (ImGui.Selectable($"{option.Label}##{option.Preset}", selected, ImGuiSelectableFlags.None, new Vector2(420, 0)))
            {
                selectedModelPreset = option.Preset;
            }

            ImGui.TextDisabled($"{option.ModelId} - default thinking {FormatThinkingLevel(option.DefaultThinkingLevel)}");
        }

        ImGui.Separator();
        ImGui.BeginDisabled(!model.CanChangeSettings);
        if (ImGui.Button("Apply##PiModel"u8) && selectModel(selectedModelPreset))
        {
            modelModalOpen = false;
            ImGui.CloseCurrentPopup();
        }

        ImGui.EndDisabled();
        ImGui.SameLine();
        if (ImGui.Button("Cancel##PiModel"u8))
        {
            modelModalOpen = false;
            ImGui.CloseCurrentPopup();
        }

        ImGui.EndPopup();
    }

    private string CurrentModelLabel()
    {
        var option = FindModelOption(model.ModelPreset);
        if (option is not null)
        {
            return option.Label;
        }

        if (model.Provider is not null && model.ModelId is not null)
        {
            return $"{model.Provider}/{model.ModelId}";
        }

        return "Unavailable";
    }

    private static ModelOption? FindModelOption(string? preset) =>
        ModelOptions.FirstOrDefault(option => option.Preset == preset);

    private static bool IsKnownModelPreset(string? preset) => FindModelOption(preset) is not null;

    private static string FormatThinkingLevel(string? level)
    {
        if (string.IsNullOrWhiteSpace(level))
        {
            return "Unavailable";
        }

        return char.ToUpperInvariant(level[0]) + level[1..];
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

    private sealed record ModelOption(
        string Preset,
        string Label,
        string ModelId,
        string DefaultThinkingLevel);
}
