# Bridge protocol v1

The Dalamud plugin connects to an authenticated WebSocket on IPv4 loopback. The default endpoint is `ws://127.0.0.1:32145`. The bridge does not support a path, query parameters, remote hosts, TLS termination, or bearer tokens in URLs.

## Connection and authentication

The bridge listens on `127.0.0.1` only. A client must send this header in the WebSocket upgrade:

```text
Authorization: Bearer <token>
```

The bridge stores a token containing 32 random bytes in its private configuration file. It compares the SHA-256 digests of the stored and supplied tokens with a timing-safe comparison. Failed authentication receives HTTP 401 before the WebSocket opens. Tokens are absent from bridge logs and pairing URLs.

Each WebSocket text frame contains one JSON object. Every object has `"version": 1` and one supported `type`. The maximum UTF-8 payload is 65,536 bytes. Binary frames, malformed JSON, extra fields, unsupported versions, and unknown message types are rejected. `src/bridge/src/protocol.ts` and `src/PiDalamud.Plugin/Bridge/BridgeMessage.cs` enforce this contract.

## Bridge logs

The bridge writes one JSON object per log line. It records `plugin_message_received` and `plugin_message_sent` events with the message type, request ID when present, and text length for prompts or completed responses. It records each Pi `thinking_start` event as `pi_thinking` with the active request ID when available. When a completed response does not fit one frame, it records `response_truncated` with the original and sent text lengths.

Logs do not contain bearer tokens, prompt text, completed response text, or thinking text.

## Plugin to bridge

### `prompt`

```json
{
  "version": 1,
  "type": "prompt",
  "requestId": "3f0426b1-838c-4d47-8ac8-787178856bef",
  "text": "Explain the failing test"
}
```

`requestId` is a UUID. After trimming, `text` must contain 1 to 16,000 Unicode scalar values. The bridge accepts one active prompt. It returns `busy` for another prompt until the active prompt settles or aborts.

### `abort`

```json
{
  "version": 1,
  "type": "abort",
  "requestId": "3f0426b1-838c-4d47-8ac8-787178856bef"
}
```

The request ID must match the active prompt.

### `get_status`

```json
{
  "version": 1,
  "type": "get_status"
}
```

### `new_session`

```json
{
  "version": 1,
  "type": "new_session"
}
```

The bridge rejects this message while a prompt is active.

### `select_model`

```json
{
  "version": 1,
  "type": "select_model",
  "preset": "luna"
}
```

The only supported presets are:

| Preset | Pi provider/model | Default thinking |
| --- | --- | --- |
| `luna` | `openai-codex/gpt-5.6-luna` | `max` |
| `sol` | `openai-codex/gpt-5.6-sol` | `high` |

The bridge rejects this message while a prompt is active. A successful model change also applies the preset's default thinking level.

### `set_thinking_level`

```json
{
  "version": 1,
  "type": "set_thinking_level",
  "level": "off"
}
```

`level` must be one of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`, and must be reported as available for the current model.

## Bridge to plugin

### `ready`

```json
{
  "version": 1,
  "type": "ready",
  "sessionId": "pi-session-id",
  "state": "idle"
}
```

The bridge sends `ready` after Pi starts or creates a new session. A reconnecting plugin still sends `get_status` and waits for `status` before enabling prompts.

### `accepted`

```json
{
  "version": 1,
  "type": "accepted",
  "requestId": "3f0426b1-838c-4d47-8ac8-787178856bef"
}
```

Pi accepted the prompt. The plugin appends the user entry at this point.

### `settled`

```json
{
  "version": 1,
  "type": "settled",
  "requestId": "3f0426b1-838c-4d47-8ac8-787178856bef",
  "sessionId": "pi-session-id",
  "text": "The completed assistant response"
}
```

The bridge sends this only after Pi emits `agent_settled` and `get_last_assistant_text` returns text. There are no token delta messages in protocol v1.

Pi responses have no fixed length, so the bridge caps `text` before sending. When the serialized message would exceed 65,536 bytes, the bridge keeps the longest prefix of the response that fits, cut on a Unicode code point boundary, and appends this marker:

```text
\n[Response truncated to fit the bridge message size limit]
```

A truncated frame is still a valid `settled` message, and the marker makes the cut visible in the transcript. Only `settled` can approach the frame limit; every other message is bounded by its fixed fields.

### `status`

```json
{
  "version": 1,
  "type": "status",
  "state": "running",
  "sessionId": "pi-session-id",
  "activeRequestId": "3f0426b1-838c-4d47-8ac8-787178856bef"
}
```

`state` is `starting`, `idle`, `running`, or `error`. `activeRequestId` is present only while a prompt is active.

### `model_state`

```json
{
  "version": 1,
  "type": "model_state",
  "preset": "luna",
  "provider": "openai-codex",
  "modelId": "gpt-5.6-luna",
  "thinkingLevel": "max",
  "availableThinkingLevels": ["off", "minimal", "low", "medium", "high", "xhigh", "max"]
}
```

The bridge sends `model_state` after `get_status`, after a successful model or thinking-level change, and after a supervised Pi restart. `preset`, `provider`, `modelId`, and `thinkingLevel` may be `null` when Pi has no recognized current model. The plugin must build its thinking-level picker from `availableThinkingLevels`.

### `aborted`

```json
{
  "version": 1,
  "type": "aborted",
  "requestId": "3f0426b1-838c-4d47-8ac8-787178856bef"
}
```

### `error`

```json
{
  "version": 1,
  "type": "error",
  "code": "busy",
  "message": "Pi is already running",
  "requestId": "3f0426b1-838c-4d47-8ac8-787178856bef"
}
```

`requestId` is omitted for errors that do not belong to one prompt. Stable protocol codes are:

- `unauthorized`
- `invalid_message`
- `message_too_large`
- `busy`
- `request_not_active`
- `pi_start_failed`
- `pi_exited`
- `pi_prompt_failed`
- `pi_abort_failed`
- `session_switch_failed`
- `model_switch_failed`
- `thinking_level_failed`
- `internal_error`

Error messages never contain stack traces, provider credentials, prompt text, filesystem paths, or raw Pi events.

## Pi RPC mapping

The bridge accepts only the six plugin operations above. It writes these RPC command types to Pi:

| Plugin operation | Pi RPC command |
| --- | --- |
| `prompt` | `prompt` |
| `abort` | `abort` |
| `get_status` | `get_state` |
| `new_session` | `new_session`, followed by `get_state` |
| `select_model` | `set_model`, followed by `get_available_thinking_levels` and the preset default `set_thinking_level` |
| `set_thinking_level` | `get_available_thinking_levels`, then `set_thinking_level` |
| Completed response | `get_last_assistant_text` after `agent_settled` |

There is no raw RPC message, shell operation, workspace field, or `bash` route in this protocol.
