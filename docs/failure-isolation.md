# Failure-isolation checks

Run the automated checks from the repository root:

```bash
pnpm install --frozen-lockfile
pnpm test
export DALAMUD_HOME=/path/to/dalamud/Hooks/dev
pnpm lint
pnpm build
```

The tests exercise these isolation boundaries:

| Failure | Automated check | Required result |
| --- | --- | --- |
| Bridge stopped | `MissingBridgeReportsDisconnectedAndRemainsDisposable` | The client queues `Disconnected`; cancellation completes without blocking. |
| Bridge killed during a request | `BridgeLossFailsTheActiveUiRequestAndKeepsTranscript` | The accepted user entry remains, an error entry is added, and the request clears. |
| Pi killed during a request | `fails an active request when Pi exits, restarts once, and accepts another prompt` | The bridge returns `pi_exited`, restarts once, and completes the next prompt. |
| Malformed Pi stdout | `fails the worker on malformed stdout` and `sanitizes malformed Pi output and keeps the server alive` | The active request fails with sanitized `internal_error`; the WebSocket server remains alive. |
| Malformed bridge JSON | `RejectsMalformedBridgeJsonAndCancelsOnDispose` | Parsing happens off the framework thread and queues `ProtocolFailureEvent`. |
| Plugin unload during a request | `DisposalDuringARequestLeavesNoNetworkCallbacks` | Disposal returns without waiting, the connection task ends, and no event remains queued. |

The plugin drains no more than 64 bridge events in one framework update. Command handlers and ImGui draw methods perform no network calls. The plugin never subscribes to ambient chat events and uses `IChatGui.Print` only for local notices.

Before using the plugin in FFXIV, repeat these manual checks in a development installation:

1. Start FFXIV with the bridge stopped. Open `/pi`, confirm `Disconnected`, and move and resize the window.
2. Start the bridge, submit a prompt, then stop the bridge process. Confirm the game keeps rendering and the transcript shows a recoverable error.
3. Submit a prompt and stop the Pi child only. Confirm the bridge reports an error and later reconnects after its one supervised restart.
4. Submit a prompt and reload the dev plugin. Confirm `/pi` has one handler after reload and the old window, draw callback, framework callback, and socket do not remain.
5. Send party and tell messages. Confirm the bridge logs no prompt operation.
