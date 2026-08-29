# Bridge protocol v1

The Dalamud plugin connects to an authenticated WebSocket on IPv4 loopback. The default endpoint is `ws://127.0.0.1:32145`. The bridge does not support a path, query parameters, remote hosts, TLS termination, or bearer tokens in URLs.

## Connection and authentication

The bridge listens on `127.0.0.1` only. A client must send this header in the WebSocket upgrade:

```text
Authorization: Bearer <token>
```

The bridge stores a token containing 32 random bytes in its private configuration file. It compares the SHA-256 digests of the stored and supplied tokens with a timing-safe comparison. Failed authentication receives HTTP 401 before the WebSocket opens. Tokens are absent from bridge logs and pairing URLs.

Each WebSocket text frame contains one JSON object. Every object has `"version": 1` and one supported `type`. The maximum UTF-8 payload is 65,536 bytes. Binary frames, malformed JSON, extra fields, unsupported versions, and unknown message types are rejected. `src/bridge/src/protocol.ts` and `src/PiDalamud.Plugin/Bridge/BridgeMessage.cs` enforce this contract.

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
- `internal_error`

Error messages never contain stack traces, provider credentials, prompt text, filesystem paths, or raw Pi events.

## Pi RPC mapping

The bridge accepts only the four plugin operations above. It writes these RPC command types to Pi:

| Plugin operation | Pi RPC command |
| --- | --- |
| `prompt` | `prompt` |
| `abort` | `abort` |
| `get_status` | `get_state` |
| `new_session` | `new_session`, followed by `get_state` |
| Completed response | `get_last_assistant_text` after `agent_settled` |

There is no raw RPC message, shell operation, workspace field, or `bash` route in this protocol.
