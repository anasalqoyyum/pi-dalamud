import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";

import { BridgeServer } from "../src/ws-server.js";
import { PiRpcProcess } from "../src/pi-rpc-process.js";

const here = dirname(fileURLToPath(import.meta.url));
const fakePi = join(here, "../../../test-fixtures/fake-pi-rpc.mjs");
const token = "test-token-with-more-than-thirty-two-random-bytes";
const servers: BridgeServer[] = [];
const clients: WebSocket[] = [];

type LogEntry = {
  readonly level: "info" | "error";
  readonly event: string;
  readonly context: Readonly<Record<string, unknown>>;
};

async function startBridge(
  commandLog?: string,
  logs: LogEntry[] = [],
): Promise<{
  readonly server: BridgeServer;
  readonly url: string;
}> {
  const workspace = await mkdtemp(join(tmpdir(), "pi-dalamud-bridge-"));
  const server = new BridgeServer({
    host: "127.0.0.1",
    port: 0,
    token,
    createPiProcess: () =>
      new PiRpcProcess({
        command: process.execPath,
        args: [fakePi],
        workingDirectory: workspace,
        environment: commandLog
          ? { ...process.env, FAKE_PI_COMMAND_LOG: commandLog }
          : process.env,
        onStderr: () => undefined,
      }),
    log: {
      info: (event, context = {}) =>
        logs.push({ level: "info", event, context }),
      error: (event, context = {}) =>
        logs.push({ level: "error", event, context }),
    },
  });
  servers.push(server);
  const address = await server.start();
  return { server, url: `ws://127.0.0.1:${address.port}` };
}

async function connect(url: string, bearerToken = token): Promise<TestClient> {
  const socket = new WebSocket(url, {
    headers: { Authorization: `Bearer ${bearerToken}` },
  });
  clients.push(socket);
  const client = new TestClient(socket);
  await client.opened;
  return client;
}

afterEach(async () => {
  for (const client of clients.splice(0)) client.terminate();
  await Promise.all(servers.splice(0).map((server) => server.stop()));
});

describe("authenticated WebSocket bridge", () => {
  it("completes an end-to-end prompt through the fake Pi process", async () => {
    const { url } = await startBridge();
    const client = await connect(url);

    await expect(client.next()).resolves.toMatchObject({
      type: "ready",
      state: "idle",
    });
    const requestId = crypto.randomUUID();
    client.send({ version: 1, type: "prompt", requestId, text: "answer me" });

    await expect(client.next()).resolves.toEqual({
      version: 1,
      type: "accepted",
      requestId,
    });
    await expect(client.next()).resolves.toEqual({
      version: 1,
      type: "settled",
      requestId,
      sessionId: "fake-session-1",
      text: "Fake Pi completed: answer me",
    });
  });

  it("selects a fixed model and exposes its thinking capabilities", async () => {
    const logs: LogEntry[] = [];
    const { url } = await startBridge(undefined, logs);
    const client = await connect(url);

    await expect(client.next()).resolves.toMatchObject({
      type: "ready",
      state: "idle",
    });
    client.send({ version: 1, type: "get_status" });
    await expect(client.next()).resolves.toMatchObject({ type: "status" });
    await expect(client.next()).resolves.toEqual({
      version: 1,
      type: "model_state",
      preset: "luna",
      provider: "openai-codex",
      modelId: "gpt-5.6-luna",
      thinkingLevel: "max",
      availableThinkingLevels: [
        "off",
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
      ],
    });
    expect(logs).toContainEqual({
      level: "info",
      event: "plugin_message_sent",
      context: {
        type: "model_state",
        preset: "luna",
        provider: "openai-codex",
        modelId: "gpt-5.6-luna",
        thinkingLevel: "max",
      },
    });

    client.send({ version: 1, type: "select_model", preset: "sol" });
    await expect(client.next()).resolves.toEqual({
      version: 1,
      type: "model_state",
      preset: "sol",
      provider: "openai-codex",
      modelId: "gpt-5.6-sol",
      thinkingLevel: "high",
      availableThinkingLevels: ["off", "minimal", "low", "medium", "high"],
    });

    client.send({ version: 1, type: "set_thinking_level", level: "max" });
    await expect(client.next()).resolves.toMatchObject({
      type: "error",
      code: "thinking_level_failed",
    });

    client.send({ version: 1, type: "set_thinking_level", level: "off" });
    await expect(client.next()).resolves.toMatchObject({
      type: "model_state",
      preset: "sol",
      thinkingLevel: "off",
    });
  });

  it("logs protocol traffic and thinking without recording message contents", async () => {
    const logs: LogEntry[] = [];
    const { url } = await startBridge(undefined, logs);
    const client = await connect(url);

    await client.next();
    const requestId = crypto.randomUUID();
    const prompt = "private prompt text";
    client.send({ version: 1, type: "prompt", requestId, text: prompt });

    await client.next();
    await client.next();

    expect(logs).toContainEqual({
      level: "info",
      event: "plugin_message_received",
      context: { type: "prompt", requestId, textLength: prompt.length },
    });
    expect(logs).toContainEqual({
      level: "info",
      event: "pi_thinking",
      context: { requestId },
    });
    expect(
      logs.some(
        ({ event, context }) =>
          event === "plugin_message_sent" &&
          context.type === "accepted" &&
          context.requestId === requestId,
      ),
    ).toBe(true);
    expect(
      logs.some(
        ({ event, context }) =>
          event === "plugin_message_sent" &&
          context.type === "settled" &&
          context.requestId === requestId &&
          context.textLength ===
            "Fake Pi completed: private prompt text".length,
      ),
    ).toBe(true);
    expect(JSON.stringify(logs)).not.toContain(prompt);
  });

  it("orders accepted before settled when Pi settles before its prompt response", async () => {
    const { url } = await startBridge();
    const client = await connect(url);
    await client.next();
    const requestId = crypto.randomUUID();
    client.send({
      version: 1,
      type: "prompt",
      requestId,
      text: "__settle_before_accept__",
    });

    await expect(client.next()).resolves.toMatchObject({
      type: "accepted",
      requestId,
    });
    await expect(client.next()).resolves.toMatchObject({
      type: "settled",
      requestId,
      text: "settled before acceptance",
    });
  });

  it("reports a rejected prompt and leaves Pi idle for another request", async () => {
    const { url } = await startBridge();
    const client = await connect(url);
    await client.next();
    const requestId = crypto.randomUUID();
    client.send({ version: 1, type: "prompt", requestId, text: "__reject__" });

    await expect(client.next()).resolves.toMatchObject({
      type: "error",
      code: "pi_prompt_failed",
      requestId,
    });
    client.send({ version: 1, type: "get_status" });
    await expect(client.next()).resolves.toMatchObject({
      type: "status",
      state: "idle",
    });
  });

  it("rejects an invalid bearer token during upgrade", async () => {
    const { url } = await startBridge();

    await expect(connect(url, "wrong-token")).rejects.toThrow(/401/);
  });

  it("returns busy for a second prompt while Pi runs", async () => {
    const { url } = await startBridge();
    const client = await connect(url);
    await client.next();
    const activeRequestId = crypto.randomUUID();
    const secondRequestId = crypto.randomUUID();

    client.send({
      version: 1,
      type: "prompt",
      requestId: activeRequestId,
      text: "__hang__",
    });
    client.send({
      version: 1,
      type: "prompt",
      requestId: secondRequestId,
      text: "second",
    });

    await expect(client.next()).resolves.toEqual({
      version: 1,
      type: "accepted",
      requestId: activeRequestId,
    });
    await expect(client.next()).resolves.toMatchObject({
      version: 1,
      type: "error",
      code: "busy",
      requestId: secondRequestId,
    });
  });

  it("aborts only the matching active request", async () => {
    const { url } = await startBridge();
    const client = await connect(url);
    await client.next();
    const requestId = crypto.randomUUID();
    client.send({ version: 1, type: "prompt", requestId, text: "__hang__" });
    await client.next();

    client.send({ version: 1, type: "abort", requestId: crypto.randomUUID() });
    await expect(client.next()).resolves.toMatchObject({
      type: "error",
      code: "request_not_active",
    });

    client.send({ version: 1, type: "abort", requestId });
    await expect(client.next()).resolves.toEqual({
      version: 1,
      type: "aborted",
      requestId,
    });
  });

  it("rejects unknown messages without forwarding them to Pi", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-dalamud-ws-commands-"));
    const commandLog = join(directory, "commands.txt");
    const { url } = await startBridge(commandLog);
    const client = await connect(url);
    await client.next();

    client.send({ version: 1, type: "bash", command: "id" });
    await expect(client.next()).resolves.toMatchObject({
      type: "error",
      code: "invalid_message",
    });

    const commands = (await readFile(commandLog, "utf8")).trim().split("\n");
    expect(commands).toEqual(["get_state", "get_available_thinking_levels"]);
    expect(commands).not.toContain("bash");
  });

  it("rejects binary and oversized frames", async () => {
    const { url } = await startBridge();
    const binaryClient = await connect(url);
    await binaryClient.next();
    binaryClient.socket.send(Buffer.from("binary"));
    await expect(binaryClient.next()).resolves.toMatchObject({
      type: "error",
      code: "invalid_message",
    });

    const oversizedClient = await connect(url);
    await oversizedClient.next();
    oversizedClient.socket.send("x".repeat(65_537));
    await expect(oversizedClient.closed).resolves.toBe(1009);
  });

  it("rejects new session while busy and creates one while idle", async () => {
    const { url } = await startBridge();
    const client = await connect(url);
    await client.next();
    const requestId = crypto.randomUUID();
    client.send({ version: 1, type: "prompt", requestId, text: "__hang__" });
    await client.next();

    client.send({ version: 1, type: "new_session" });
    await expect(client.next()).resolves.toMatchObject({
      type: "error",
      code: "busy",
    });
    client.send({ version: 1, type: "abort", requestId });
    await client.next();
    client.send({ version: 1, type: "new_session" });

    await expect(client.next()).resolves.toEqual({
      version: 1,
      type: "ready",
      sessionId: "fake-session-2",
      state: "idle",
    });
  });

  it("sanitizes malformed Pi output and keeps the server alive", async () => {
    const { url } = await startBridge();
    const client = await connect(url);
    await client.next();
    const requestId = crypto.randomUUID();
    client.send({
      version: 1,
      type: "prompt",
      requestId,
      text: "__malformed__",
    });
    await client.next();

    const error = await client.next();
    expect(error).toMatchObject({
      version: 1,
      type: "error",
      code: "internal_error",
      requestId,
    });
    expect(JSON.stringify(error)).not.toContain("{not-json}");

    client.send({ version: 1, type: "get_status" });
    await expect(client.next()).resolves.toMatchObject({ type: "status" });
  });

  it("fails an active request when Pi exits, restarts once, and accepts another prompt", async () => {
    const { url } = await startBridge();
    const client = await connect(url);
    await client.next();
    const failedRequestId = crypto.randomUUID();
    client.send({
      version: 1,
      type: "prompt",
      requestId: failedRequestId,
      text: "__exit__",
    });
    await client.next();

    await expect(client.next()).resolves.toMatchObject({
      type: "error",
      code: "pi_exited",
      requestId: failedRequestId,
    });
    await expect(client.next()).resolves.toMatchObject({
      type: "ready",
      state: "idle",
    });
    await expect(client.next()).resolves.toMatchObject({
      type: "model_state",
      preset: "luna",
    });

    const recoveredRequestId = crypto.randomUUID();
    client.send({
      version: 1,
      type: "prompt",
      requestId: recoveredRequestId,
      text: "after restart",
    });
    await expect(client.next()).resolves.toMatchObject({
      type: "accepted",
      requestId: recoveredRequestId,
    });
    await expect(client.next()).resolves.toMatchObject({
      type: "settled",
      requestId: recoveredRequestId,
      text: "Fake Pi completed: after restart",
    });
  });
});

class TestClient {
  private readonly messages: unknown[] = [];
  private readonly waiters: Array<(message: unknown) => void> = [];
  public readonly opened: Promise<void>;
  public readonly closed: Promise<number>;

  public constructor(public readonly socket: WebSocket) {
    this.opened = new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("unexpected-response", (_request, response) => {
        reject(
          new Error(`WebSocket upgrade failed with ${response.statusCode}`),
        );
      });
      socket.once("error", reject);
    });
    this.closed = new Promise<number>((resolve) => {
      socket.once("close", resolve);
    });
    socket.on("message", (data) => {
      const message: unknown = JSON.parse(data.toString());
      const waiter = this.waiters.shift();
      if (waiter) waiter(message);
      else this.messages.push(message);
    });
  }

  public send(message: unknown): void {
    this.socket.send(JSON.stringify(message));
  }

  public next(): Promise<unknown> {
    const message = this.messages.shift();
    if (message) return Promise.resolve(message);
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}
