import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";

import WebSocket, { WebSocketServer } from "ws";

import {
  PiRpcProcess,
  PiRpcProcessExitError,
  PiRpcProtocolError,
  PiRpcStartError,
  type PiRpcState,
} from "./pi-rpc-process.js";
import {
  findModelPreset,
  modelPresets,
  type ModelPreset,
  type ThinkingLevel,
} from "./model-presets.js";
import {
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  ProtocolMessageError,
  parsePluginMessage,
  type BridgeErrorCode,
  type BridgeMessage,
  type ModelState,
  type BridgeState,
  type PluginMessage,
} from "./protocol.js";

type BridgeLog = {
  readonly info: (
    event: string,
    context?: Readonly<Record<string, unknown>>,
  ) => void;
  readonly error: (
    code: BridgeErrorCode,
    context?: Readonly<Record<string, unknown>>,
  ) => void;
};

type BridgeServerOptions = {
  readonly host: "127.0.0.1";
  readonly port: number;
  readonly token: string;
  readonly createPiProcess: () => PiRpcProcess;
  readonly log: BridgeLog;
};

export type BridgeAddress = {
  readonly host: "127.0.0.1";
  readonly port: number;
};

type ActiveRequest = {
  readonly requestId: string;
  accepted: boolean;
  settled: boolean;
  settling: boolean;
};

const emptyModelState: ModelState = {
  preset: null,
  provider: null,
  modelId: null,
  thinkingLevel: null,
  availableThinkingLevels: [],
};

export class BridgeServer {
  private readonly httpServer: Server;
  private readonly webSocketServer: WebSocketServer;
  private pi: PiRpcProcess | undefined;
  private removePiListener: (() => void) | undefined;
  private state: BridgeState = "starting";
  private sessionId = "unavailable";
  private modelState: ModelState = emptyModelState;
  private activeRequest: ActiveRequest | undefined;
  private stopping = false;
  private restartUsed = false;
  private restartTimer: NodeJS.Timeout | undefined;

  public constructor(private readonly options: BridgeServerOptions) {
    this.httpServer = createServer((_request, response) => {
      response.writeHead(404).end();
    });
    this.webSocketServer = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_FRAME_BYTES,
      perMessageDeflate: false,
    });

    this.httpServer.on("upgrade", (request, socket, head) =>
      this.handleUpgrade(request, socket, head),
    );
    this.webSocketServer.on("connection", (socket) =>
      this.handleConnection(socket),
    );
  }

  public async start(): Promise<BridgeAddress> {
    try {
      await this.startPi();
    } catch (error: unknown) {
      this.options.log.error("pi_start_failed", { error: errorName(error) });
    }

    await new Promise<void>((resolve, reject) => {
      this.httpServer.once("error", reject);
      this.httpServer.listen(this.options.port, this.options.host, resolve);
    });

    const address = this.httpServer.address();
    if (!isAddressInfo(address))
      throw new Error("Bridge did not acquire a TCP address");
    this.options.log.info("bridge_listening", {
      host: this.options.host,
      port: address.port,
    });
    return { host: this.options.host, port: address.port };
  }

  public async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.removePiListener?.();
    for (const socket of this.webSocketServer.clients) socket.terminate();

    const closeWebSockets = new Promise<void>((resolve) => {
      this.webSocketServer.close(() => resolve());
    });
    const closeHttp = new Promise<void>((resolve, reject) => {
      if (!this.httpServer.listening) {
        resolve();
        return;
      }
      this.httpServer.close((error) => (error ? reject(error) : resolve()));
    });
    await Promise.all([closeWebSockets, closeHttp, this.pi?.dispose()]);
    this.options.log.info("bridge_stopped");
  }

  private async startPi(): Promise<void> {
    const pi = this.options.createPiProcess();
    this.pi = pi;
    this.state = "starting";
    this.removePiListener = pi.onEvent((event) => {
      switch (event.type) {
        case "agent_settled":
          void this.handleAgentSettled(pi);
          return;
        case "thinking_started": {
          const requestId = this.activeRequest?.requestId;
          if (requestId) {
            this.options.log.info("pi_thinking", { requestId });
          } else {
            this.options.log.info("pi_thinking");
          }
          return;
        }
        default: {
          const exhaustive: never = event;
          throw new Error(`Unhandled Pi event: ${String(exhaustive)}`);
        }
      }
    });
    void pi
      .waitForExit()
      .catch((error: unknown) => this.handlePiFailure(pi, error));

    try {
      const state = await pi.start();
      if (this.pi !== pi) return;
      await this.refreshModelState(pi, state);
      if (this.pi !== pi) return;
      this.sessionId = state.sessionId;
      this.state = state.isStreaming ? "running" : "idle";
      this.options.log.info("pi_started", { sessionId: state.sessionId });
    } catch (error: unknown) {
      if (this.pi === pi) {
        this.state = "error";
        this.pi = undefined;
      }
      await pi.dispose();
      throw error;
    }
  }

  private handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void {
    if (!isAuthorized(request.headers.authorization, this.options.token)) {
      this.options.log.error("unauthorized");
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    this.webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      this.webSocketServer.emit("connection", webSocket, request);
    });
  }

  private handleConnection(socket: WebSocket): void {
    this.options.log.info("client_connected");
    if (this.state === "idle") {
      this.send(socket, {
        version: PROTOCOL_VERSION,
        type: "ready",
        sessionId: this.sessionId,
        state: "idle",
      });
    } else {
      this.sendStatus(socket);
    }

    let messageQueue = Promise.resolve();
    socket.on("message", (data, isBinary) => {
      messageQueue = messageQueue
        .then(() => this.handleFrame(socket, data, isBinary))
        .catch((error: unknown) => {
          this.options.log.error("internal_error", { error: errorName(error) });
          this.sendError(
            socket,
            "internal_error",
            "Bridge could not process the message",
          );
        });
    });
    socket.on("error", (error) => {
      this.options.log.error("internal_error", { error: error.name });
    });
    socket.on("close", () => this.options.log.info("client_disconnected"));
  }

  private async handleFrame(
    socket: WebSocket,
    data: WebSocket.RawData,
    isBinary: boolean,
  ): Promise<void> {
    if (isBinary) {
      this.options.log.error("invalid_message", {
        direction: "inbound",
        frame: "binary",
      });
      this.sendError(
        socket,
        "invalid_message",
        "Binary frames are not supported",
      );
      socket.close(1003, "Text frames required");
      return;
    }

    let message: PluginMessage;
    try {
      message = parsePluginMessage(data.toString());
    } catch (error: unknown) {
      if (error instanceof ProtocolMessageError) {
        this.options.log.error(error.code, { direction: "inbound" });
        this.sendError(socket, error.code, error.message);
        return;
      }
      throw error;
    }

    this.options.log.info(
      "plugin_message_received",
      messageLogContext(message),
    );

    switch (message.type) {
      case "prompt":
        await this.handlePrompt(socket, message);
        return;
      case "abort":
        await this.handleAbort(socket, message.requestId);
        return;
      case "get_status":
        await this.handleGetStatus(socket);
        return;
      case "new_session":
        await this.handleNewSession(socket);
        return;
      case "select_model":
        await this.handleSelectModel(socket, message);
        return;
      case "set_thinking_level":
        await this.handleSetThinkingLevel(socket, message);
        return;
      default: {
        const exhaustive: never = message;
        throw new Error(`Unhandled plugin message: ${String(exhaustive)}`);
      }
    }
  }

  private async handlePrompt(
    socket: WebSocket,
    message: Extract<PluginMessage, { readonly type: "prompt" }>,
  ): Promise<void> {
    if (this.activeRequest) {
      this.sendError(
        socket,
        "busy",
        "Pi is already running",
        message.requestId,
      );
      return;
    }

    const pi = this.pi;
    if (!pi || this.state === "error" || this.state === "starting") {
      this.sendError(
        socket,
        "pi_start_failed",
        "Pi is unavailable",
        message.requestId,
      );
      return;
    }

    this.activeRequest = {
      requestId: message.requestId,
      accepted: false,
      settled: false,
      settling: false,
    };
    this.state = "running";
    try {
      await pi.prompt(message.text);
      const active = this.activeRequest;
      if (!active || active.requestId !== message.requestId) return;
      active.accepted = true;
      this.send(socket, {
        version: PROTOCOL_VERSION,
        type: "accepted",
        requestId: message.requestId,
      });
      if (active.settled) void this.handleAgentSettled(pi);
    } catch (error: unknown) {
      if (this.pi !== pi) return;
      if (this.activeRequest?.requestId === message.requestId)
        this.activeRequest = undefined;
      this.state = "idle";
      this.options.log.error("pi_prompt_failed", { error: errorName(error) });
      this.sendError(
        socket,
        "pi_prompt_failed",
        "Pi rejected the prompt",
        message.requestId,
      );
    }
  }

  private async handleAbort(
    socket: WebSocket,
    requestId: string,
  ): Promise<void> {
    if (this.activeRequest?.requestId !== requestId) {
      this.sendError(
        socket,
        "request_not_active",
        "Request is not active",
        requestId,
      );
      return;
    }

    const pi = this.pi;
    if (!pi) {
      this.sendError(socket, "pi_abort_failed", "Pi is unavailable", requestId);
      return;
    }

    const active = this.activeRequest;
    this.activeRequest = undefined;
    try {
      await pi.abort();
      this.state = "idle";
      this.send(socket, {
        version: PROTOCOL_VERSION,
        type: "aborted",
        requestId,
      });
    } catch (error: unknown) {
      if (this.pi === pi && !this.activeRequest) {
        this.activeRequest = active;
        this.state = "running";
      }
      this.options.log.error("pi_abort_failed", { error: errorName(error) });
      this.sendError(
        socket,
        "pi_abort_failed",
        "Pi could not abort the request",
        requestId,
      );
    }
  }

  private async handleGetStatus(socket: WebSocket): Promise<void> {
    const pi = this.pi;
    if (pi && this.state !== "error" && this.state !== "starting") {
      try {
        await this.refreshModelState(pi);
      } catch (error: unknown) {
        this.options.log.error("internal_error", { error: errorName(error) });
        this.state = "error";
      }
    }
    this.sendStatus(socket);
    this.sendModelState(socket);
  }

  private async handleNewSession(socket: WebSocket): Promise<void> {
    if (this.activeRequest) {
      this.sendError(socket, "busy", "Pi is already running");
      return;
    }

    const pi = this.pi;
    if (!pi || this.state === "error" || this.state === "starting") {
      this.sendError(socket, "session_switch_failed", "Pi is unavailable");
      return;
    }

    try {
      this.sessionId = await pi.newSession();
      await this.refreshModelState(pi);
      this.state = "idle";
      this.send(socket, {
        version: PROTOCOL_VERSION,
        type: "ready",
        sessionId: this.sessionId,
        state: "idle",
      });
      this.sendModelState(socket);
    } catch (error: unknown) {
      this.options.log.error("session_switch_failed", {
        error: errorName(error),
      });
      this.sendError(
        socket,
        "session_switch_failed",
        "Pi could not create a session",
      );
    }
  }

  private async handleSelectModel(
    socket: WebSocket,
    message: Extract<PluginMessage, { readonly type: "select_model" }>,
  ): Promise<void> {
    if (this.activeRequest || this.state === "running") {
      this.sendError(socket, "busy", "Pi is already running");
      return;
    }

    const pi = this.pi;
    if (!pi || this.state === "error" || this.state === "starting") {
      this.sendError(socket, "model_switch_failed", "Pi is unavailable");
      return;
    }

    const preset: ModelPreset = message.preset;
    const definition = modelPresets[preset];
    try {
      await pi.setModel(definition.provider, definition.modelId);
      const availableThinkingLevels = await pi.getAvailableThinkingLevels();
      if (!availableThinkingLevels.includes(definition.defaultThinkingLevel)) {
        throw new PiRpcProtocolError(
          "Pi does not support the preset thinking level",
        );
      }
      await pi.setThinkingLevel(definition.defaultThinkingLevel);
      await this.refreshModelState(pi);
      this.broadcastModelState();
    } catch (error: unknown) {
      this.options.log.error("model_switch_failed", {
        error: errorName(error),
      });
      this.sendError(
        socket,
        "model_switch_failed",
        "Pi could not change the model",
      );
    }
  }

  private async handleSetThinkingLevel(
    socket: WebSocket,
    message: Extract<PluginMessage, { readonly type: "set_thinking_level" }>,
  ): Promise<void> {
    if (this.activeRequest || this.state === "running") {
      this.sendError(socket, "busy", "Pi is already running");
      return;
    }

    const pi = this.pi;
    if (!pi || this.state === "error" || this.state === "starting") {
      this.sendError(socket, "thinking_level_failed", "Pi is unavailable");
      return;
    }

    const level: ThinkingLevel = message.level;
    try {
      const availableThinkingLevels = await pi.getAvailableThinkingLevels();
      if (!availableThinkingLevels.includes(level)) {
        this.sendError(
          socket,
          "thinking_level_failed",
          "That thinking level is not available for the current model",
        );
        return;
      }
      await pi.setThinkingLevel(level);
      await this.refreshModelState(pi);
      this.broadcastModelState();
    } catch (error: unknown) {
      this.options.log.error("thinking_level_failed", {
        error: errorName(error),
      });
      this.sendError(
        socket,
        "thinking_level_failed",
        "Pi could not change the thinking level",
      );
    }
  }

  private async handleAgentSettled(pi: PiRpcProcess): Promise<void> {
    if (pi !== this.pi) return;
    const active = this.activeRequest;
    if (!active) return;
    if (!active.accepted) {
      active.settled = true;
      return;
    }
    if (active.settling) return;
    active.settling = true;

    try {
      const text = await pi.getLastAssistantText();
      if (pi !== this.pi || this.activeRequest?.requestId !== active.requestId)
        return;
      this.activeRequest = undefined;
      this.state = "idle";
      this.broadcast({
        version: PROTOCOL_VERSION,
        type: "settled",
        requestId: active.requestId,
        sessionId: this.sessionId,
        text,
      });
    } catch (error: unknown) {
      this.options.log.error("internal_error", { error: errorName(error) });
      this.sendActiveError("internal_error", "Pi response could not be read");
      this.state = "error";
    }
  }

  private handlePiFailure(pi: PiRpcProcess, error: unknown): void {
    if (pi !== this.pi || this.stopping) return;
    this.removePiListener?.();
    this.pi = undefined;
    this.state = "error";

    const code: BridgeErrorCode =
      error instanceof PiRpcProtocolError
        ? "internal_error"
        : error instanceof PiRpcStartError
          ? "pi_start_failed"
          : "pi_exited";
    const message =
      code === "internal_error"
        ? "Pi emitted invalid data"
        : "Pi process exited";
    this.options.log.error(code, { error: errorName(error) });
    this.sendActiveError(code, message);

    if (error instanceof PiRpcProcessExitError && !this.restartUsed) {
      this.restartUsed = true;
      this.restartTimer = setTimeout(() => {
        void this.startPi()
          .then(() => {
            this.broadcast({
              version: PROTOCOL_VERSION,
              type: "ready",
              sessionId: this.sessionId,
              state: "idle",
            });
            this.broadcastModelState();
          })
          .catch((restartError: unknown) => {
            this.options.log.error("pi_start_failed", {
              error: errorName(restartError),
            });
          });
      }, 100);
    }
  }

  private sendActiveError(code: BridgeErrorCode, message: string): void {
    const requestId = this.activeRequest?.requestId;
    this.activeRequest = undefined;
    if (requestId) {
      this.broadcast({
        version: PROTOCOL_VERSION,
        type: "error",
        code,
        message,
        requestId,
      });
    } else {
      this.broadcast({
        version: PROTOCOL_VERSION,
        type: "error",
        code,
        message,
      });
    }
  }

  private sendStatus(socket: WebSocket): void {
    const activeRequestId = this.activeRequest?.requestId;
    if (activeRequestId) {
      this.send(socket, {
        version: PROTOCOL_VERSION,
        type: "status",
        state: this.state,
        sessionId: this.sessionId,
        activeRequestId,
      });
    } else {
      this.send(socket, {
        version: PROTOCOL_VERSION,
        type: "status",
        state: this.state,
        sessionId: this.sessionId,
      });
    }
  }

  private async refreshModelState(
    pi: PiRpcProcess,
    state?: PiRpcState,
  ): Promise<void> {
    const currentState = state ?? (await pi.getState());
    const availableThinkingLevels = await pi.getAvailableThinkingLevels();
    if (this.pi !== pi) return;

    this.sessionId = currentState.sessionId;
    this.modelState = {
      preset:
        currentState.model === null
          ? null
          : findModelPreset(currentState.model.provider, currentState.model.id),
      provider: currentState.model?.provider ?? null,
      modelId: currentState.model?.id ?? null,
      thinkingLevel: currentState.thinkingLevel,
      availableThinkingLevels,
    };
  }

  private sendModelState(socket: WebSocket): void {
    this.send(socket, {
      version: PROTOCOL_VERSION,
      type: "model_state",
      ...this.modelState,
    });
  }

  private broadcastModelState(): void {
    this.broadcast({
      version: PROTOCOL_VERSION,
      type: "model_state",
      ...this.modelState,
    });
  }

  private sendError(
    socket: WebSocket,
    code: BridgeErrorCode,
    message: string,
    requestId?: string,
  ): void {
    if (requestId) {
      this.send(socket, {
        version: PROTOCOL_VERSION,
        type: "error",
        code,
        message,
        requestId,
      });
    } else {
      this.send(socket, {
        version: PROTOCOL_VERSION,
        type: "error",
        code,
        message,
      });
    }
  }

  private broadcast(message: BridgeMessage): void {
    for (const socket of this.webSocketServer.clients)
      this.send(socket, message);
  }

  private send(socket: WebSocket, message: BridgeMessage): void {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
      this.options.log.info("plugin_message_sent", messageLogContext(message));
    }
  }
}

function messageLogContext(
  message: PluginMessage | BridgeMessage,
): Readonly<Record<string, unknown>> {
  const context: Record<string, unknown> = { type: message.type };

  if ("requestId" in message && message.requestId)
    context.requestId = message.requestId;
  if ("sessionId" in message) context.sessionId = message.sessionId;
  if ("state" in message) context.state = message.state;
  if ("code" in message) context.code = message.code;
  if (message.type === "prompt" || message.type === "settled")
    context.textLength = [...message.text].length;

  return context;
}

function isAuthorized(header: string | undefined, token: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const suppliedToken = header.slice("Bearer ".length);
  const expectedHash = createHash("sha256").update(token, "utf8").digest();
  const suppliedHash = createHash("sha256")
    .update(suppliedToken, "utf8")
    .digest();
  return timingSafeEqual(expectedHash, suppliedHash);
}

function isAddressInfo(
  value: string | AddressInfo | null,
): value is AddressInfo {
  return typeof value === "object" && value !== null;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}
