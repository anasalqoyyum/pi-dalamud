import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import { z } from "zod";

const commandSchema = z.enum([
  "prompt",
  "abort",
  "get_state",
  "new_session",
  "get_last_assistant_text",
]);

const responseSchema = z.strictObject({
  id: z.string().min(1),
  type: z.literal("response"),
  command: commandSchema,
  success: z.boolean(),
  data: z.unknown().optional(),
  error: z.string().optional(),
});

const stateDataSchema = z.object({
  isStreaming: z.boolean(),
  sessionId: z.string().min(1),
});

const lastAssistantTextDataSchema = z.object({
  text: z.string().nullable(),
});

const newSessionDataSchema = z.object({
  cancelled: z.boolean(),
});

const agentSettledSchema = z.strictObject({
  type: z.literal("agent_settled"),
});

type RpcResponse = z.infer<typeof responseSchema>;

type PendingRequest = {
  readonly command: z.infer<typeof commandSchema>;
  readonly resolve: (response: RpcResponse) => void;
  readonly reject: (error: Error) => void;
};

export type PiRpcEvent = { readonly type: "agent_settled" };

export type PiRpcState = {
  readonly isStreaming: boolean;
  readonly sessionId: string;
};

export type PiRpcProcessOptions = {
  readonly command: string;
  readonly args: readonly string[];
  readonly workingDirectory: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly onStderr: (text: string) => void;
};

export function buildPiArguments(sessionDirectory: string): string[] {
  return [
    "--mode",
    "rpc",
    "--no-approve",
    "--no-extensions",
    "--no-skills",
    "--no-context-files",
    "--tools",
    "read,grep,find,ls",
    "--session-dir",
    sessionDirectory,
  ];
}

export class JsonlRecordParser {
  private buffer = Buffer.alloc(0);

  public push(chunk: Buffer): unknown[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const records: unknown[] = [];

    while (true) {
      const lfIndex = this.buffer.indexOf(0x0a);
      if (lfIndex < 0) return records;

      let record = this.buffer.subarray(0, lfIndex);
      this.buffer = this.buffer.subarray(lfIndex + 1);
      if (record.at(-1) === 0x0d) record = record.subarray(0, -1);
      if (record.length === 0) continue;

      try {
        records.push(JSON.parse(record.toString("utf8")));
      } catch {
        throw new PiRpcProtocolError("Pi emitted malformed JSON");
      }
    }
  }

  public finish(): void {
    if (this.buffer.length > 0) {
      throw new PiRpcProtocolError(
        "Pi stdout ended with an unterminated record",
      );
    }
  }
}

export class PiRpcProcess {
  private readonly parser = new JsonlRecordParser();
  private readonly listeners = new Set<(event: PiRpcEvent) => void>();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly completion: Promise<void>;
  private resolveCompletion: () => void = () => undefined;
  private rejectCompletion: (error: Error) => void = () => undefined;
  private child: ChildProcessWithoutNullStreams | undefined;
  private disposed = false;
  private failure: Error | undefined;
  private sessionId = "";

  public constructor(private readonly options: PiRpcProcessOptions) {
    this.completion = new Promise<void>((resolve, reject) => {
      this.resolveCompletion = resolve;
      this.rejectCompletion = reject;
    });
    void this.completion.catch(() => undefined);
  }

  public async start(): Promise<PiRpcState> {
    if (this.child) throw new Error("Pi RPC process has already started");

    const child = spawn(this.options.command, [...this.options.args], {
      cwd: this.options.workingDirectory,
      env: this.options.environment,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;

    child.stdout.on("data", (chunk: Buffer) => this.handleStdout(chunk));
    child.stdout.on("end", () => this.handleStdoutEnd());
    child.stderr.on("data", (chunk: Buffer) =>
      this.options.onStderr(chunk.toString("utf8")),
    );
    child.once("error", (error) =>
      this.fail(new PiRpcStartError("Could not start Pi", { cause: error })),
    );
    child.once("exit", (code, signal) => this.handleExit(code, signal));

    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });

    return this.getState();
  }

  public onEvent(listener: (event: PiRpcEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async prompt(message: string): Promise<void> {
    await this.sendCommand("prompt", { message });
  }

  public async abort(): Promise<void> {
    await this.sendCommand("abort", {});
  }

  public async getState(): Promise<PiRpcState> {
    const response = await this.sendCommand("get_state", {});
    const parsed = stateDataSchema.safeParse(response.data);
    if (!parsed.success)
      throw new PiRpcProtocolError("Pi returned invalid state data");
    this.sessionId = parsed.data.sessionId;
    return parsed.data;
  }

  public async newSession(): Promise<string> {
    const response = await this.sendCommand("new_session", {});
    const parsed = newSessionDataSchema.safeParse(response.data);
    if (!parsed.success || parsed.data.cancelled) {
      throw new PiRpcCommandError("Pi did not create a new session");
    }

    const state = await this.getState();
    return state.sessionId;
  }

  public async getLastAssistantText(): Promise<string> {
    const response = await this.sendCommand("get_last_assistant_text", {});
    const parsed = lastAssistantTextDataSchema.safeParse(response.data);
    if (!parsed.success || parsed.data.text === null) {
      throw new PiRpcProtocolError("Pi returned no completed assistant text");
    }
    return parsed.data.text;
  }

  public getSessionId(): string {
    return this.sessionId;
  }

  public waitForExit(): Promise<void> {
    return this.completion;
  }

  public async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const stopped = new PiRpcProcessExitError("Pi RPC process stopped");
    for (const pending of this.pending.values()) pending.reject(stopped);
    this.pending.clear();

    const child = this.child;
    if (!child) {
      this.resolveCompletion();
      return;
    }

    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      const exited = await Promise.race([
        this.completion.then(
          () => true,
          () => true,
        ),
        delay(2_000, false),
      ]);
      if (!exited && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }
    await this.completion.catch(() => undefined);
  }

  private async sendCommand(
    command: z.infer<typeof commandSchema>,
    fields: Readonly<Record<string, unknown>>,
  ): Promise<RpcResponse> {
    if (this.disposed)
      throw new PiRpcProcessExitError("Pi RPC process stopped");
    if (this.failure) throw this.failure;
    const child = this.child;
    if (!child || !child.stdin.writable)
      throw new PiRpcProcessExitError("Pi is not running");

    const id = randomUUID();
    const response = new Promise<RpcResponse>((resolve, reject) => {
      this.pending.set(id, { command, resolve, reject });
    });
    const payload = JSON.stringify({ id, type: command, ...fields });

    child.stdin.write(`${payload}\n`, "utf8", (error) => {
      if (!error) return;
      const pending = this.pending.get(id);
      this.pending.delete(id);
      pending?.reject(
        new PiRpcProcessExitError("Could not write to Pi", { cause: error }),
      );
    });

    return response;
  }

  private handleStdout(chunk: Buffer): void {
    try {
      for (const record of this.parser.push(chunk)) this.handleRecord(record);
    } catch (error: unknown) {
      this.fail(
        error instanceof PiRpcProtocolError
          ? error
          : new PiRpcProtocolError("Pi stdout could not be parsed", {
              cause: error,
            }),
      );
    }
  }

  private handleStdoutEnd(): void {
    try {
      this.parser.finish();
    } catch (error: unknown) {
      this.fail(
        error instanceof PiRpcProtocolError
          ? error
          : new PiRpcProtocolError("Pi stdout ended unexpectedly", {
              cause: error,
            }),
      );
    }
  }

  private handleRecord(record: unknown): void {
    const response = responseSchema.safeParse(record);
    if (response.success) {
      const pending = this.pending.get(response.data.id);
      if (!pending)
        throw new PiRpcProtocolError("Pi returned an unknown response id");
      this.pending.delete(response.data.id);
      if (pending.command !== response.data.command) {
        pending.reject(
          new PiRpcProtocolError("Pi returned the wrong response command"),
        );
      } else if (!response.data.success) {
        pending.reject(new PiRpcCommandError("Pi rejected the RPC command"));
      } else {
        pending.resolve(response.data);
      }
      return;
    }

    if (agentSettledSchema.safeParse(record).success) {
      for (const listener of this.listeners)
        listener({ type: "agent_settled" });
      return;
    }

    if (
      !isObject(record) ||
      typeof record.type !== "string" ||
      record.type === "response" ||
      record.type === "agent_settled"
    ) {
      throw new PiRpcProtocolError("Pi emitted an invalid RPC record");
    }
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.failure) return;
    if (this.disposed) {
      this.resolveCompletion();
      return;
    }

    const detail =
      code === null ? `signal ${signal ?? "unknown"}` : `code ${code}`;
    this.fail(new PiRpcProcessExitError(`Pi exited with ${detail}`), false);
  }

  private fail(error: Error, terminate = true): void {
    if (this.failure || this.disposed) return;
    this.failure = error;
    this.rejectCompletion(error);
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();

    const child = this.child;
    if (
      terminate &&
      child &&
      child.exitCode === null &&
      child.signalCode === null
    ) {
      child.kill("SIGTERM");
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export class PiRpcStartError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PiRpcStartError";
  }
}

export class PiRpcProcessExitError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PiRpcProcessExitError";
  }
}

export class PiRpcProtocolError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PiRpcProtocolError";
  }
}

export class PiRpcCommandError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PiRpcCommandError";
  }
}
