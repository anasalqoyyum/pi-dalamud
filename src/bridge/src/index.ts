import { buildPiArguments, PiRpcProcess } from "./pi-rpc-process.js";
import { defaultConfigPath, loadBridgeConfig } from "./config.js";
import { BridgeServer } from "./ws-server.js";

type LogContext = Readonly<Record<string, unknown>>;

const log = {
  info(event: string, context: LogContext = {}): void {
    writeLog(process.stdout, "info", event, context);
  },
  error(code: string, context: LogContext = {}): void {
    writeLog(process.stderr, "error", code, context);
  },
};

async function main(): Promise<void> {
  const loaded = await loadBridgeConfig({
    configPath: process.env.PI_DALAMUD_CONFIG ?? defaultConfigPath(process.env),
    ...(process.env.PI_DALAMUD_WORKSPACE
      ? { initialWorkspace: process.env.PI_DALAMUD_WORKSPACE }
      : {}),
  });

  if (loaded.created) {
    log.info("pairing_required", {
      configPath: loaded.configPath,
      instruction: "Copy the token field into the Dalamud plugin configuration",
    });
  }

  const server = new BridgeServer({
    host: loaded.config.host,
    port: loaded.config.port,
    token: loaded.config.token,
    createPiProcess: () =>
      new PiRpcProcess({
        command: "pi",
        args: buildPiArguments(loaded.config.sessionDirectory),
        workingDirectory: loaded.config.workspace,
        environment: process.env,
        onStderr: (text) =>
          log.error("pi_stderr", {
            bytes: Buffer.byteLength(text, "utf8"),
          }),
      }),
    log,
  });

  await server.start();
  const stop = (): void => {
    void server
      .stop()
      .catch((error: unknown) =>
        log.error("bridge_stop_failed", { error: errorName(error) }),
      );
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

function writeLog(
  stream: NodeJS.WritableStream,
  level: "info" | "error",
  event: string,
  context: LogContext,
): void {
  stream.write(
    `${JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...context })}\n`,
  );
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

void main().catch((error: unknown) => {
  log.error("bridge_start_failed", { error: errorName(error) });
  process.exitCode = 1;
});
