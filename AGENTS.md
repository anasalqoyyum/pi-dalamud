# Agent guide

## Start with the right source

- Read `SPEC.md` before changing behavior. It is the authoritative product and implementation specification.
- Read `docs/protocol-v1.md` before changing messages, authentication, or bridge/plugin connection behavior. The TypeScript protocol types and C# bridge message types must stay aligned with it.
- Read `docs/failure-isolation.md` before changing lifecycle, cancellation, reconnect, subprocess, or unload behavior.
- Use `README.md` for user-facing setup. Keep implementation detail in `SPEC.md` or `docs/` instead of expanding the README.

## Project shape

- `src/PiDalamud.Plugin/` contains the C# Dalamud plugin, its bridge client, chat model, commands, and ImGui windows.
- `src/bridge/` contains the local Node.js/TypeScript WebSocket bridge and its tests.
- `tests/PiDalamud.Plugin.Tests/` contains plugin-side unit tests.
- `test-fixtures/` contains fake processes used by bridge integration tests.
- `bin/`, `obj/`, `dist/`, `node_modules/`, and `coverage/` are generated or installed output. Change their sources, not those directories.

## Boundaries to preserve

- Keep the bridge on IPv4 loopback (`127.0.0.1`) and require its bearer token. Never put the token in a URL, log, error, or transcript.
- Keep Pi credentials, session files, workspace selection, and subprocess control in the bridge. The plugin only uses the authenticated WebSocket contract.
- The MVP has one configured workspace, one active Pi session, completed responses only, and no raw Pi RPC or shell route.
- Do not add ambient game-chat ingestion, gameplay automation, packet or memory interaction, remote bridge access, arbitrary workspace selection, or Pi output sent to FFXIV servers.
- Keep network and subprocess work away from ImGui drawing and command handlers. Queue bridge events and apply them on the framework update.
- Preserve fast, non-blocking plugin disposal. A bridge or Pi failure must not freeze or crash FFXIV.

## Development loop

1. Trace the requested behavior through the plugin, bridge, protocol document, and relevant tests before editing. The scope is clear when the affected side of the trust boundary and its failure cases are identified.
2. Make the smallest change that satisfies the request. If the wire contract changes, update `docs/protocol-v1.md`, `src/bridge/src/protocol.ts`, `src/PiDalamud.Plugin/Bridge/BridgeMessage.cs`, and focused tests together. The contract is complete when all four agree.
3. Run the narrowest useful checks first, then the broader checks for cross-cutting changes:

   ```bash
   pnpm test:bridge
   pnpm test:plugin
   pnpm lint
   pnpm build
   ```

   A change is ready when relevant tests pass, generated output was not edited, and `git diff --check` is clean.
4. For lifecycle or integration changes, follow the automated and manual checks in `docs/failure-isolation.md`. Validation is complete when the affected failure path and normal path both remain usable.

Use the existing package scripts and lockfile. Do not introduce a new framework or provider SDK without first updating the specification.
