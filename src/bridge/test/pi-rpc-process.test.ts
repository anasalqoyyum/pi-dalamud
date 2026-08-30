import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  PiRpcProcess,
  PiRpcProcessExitError,
  PiRpcProtocolError,
  buildPiArguments,
} from "../src/pi-rpc-process.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "../../../test-fixtures/fake-pi-rpc.mjs");
const workers: PiRpcProcess[] = [];

async function createWorker(options?: {
  readonly commandLog?: string;
  readonly ignoreTermination?: boolean;
  readonly stderr?: (text: string) => void;
}): Promise<PiRpcProcess> {
  const workingDirectory = await mkdtemp(join(tmpdir(), "pi-dalamud-rpc-"));
  const worker = new PiRpcProcess({
    command: process.execPath,
    args: [fixture],
    workingDirectory,
    environment: {
      ...process.env,
      ...(options?.commandLog
        ? { FAKE_PI_COMMAND_LOG: options.commandLog }
        : {}),
      ...(options?.ignoreTermination ? { FAKE_PI_IGNORE_TERM: "1" } : {}),
    },
    onStderr: options?.stderr ?? (() => undefined),
  });
  workers.push(worker);
  await worker.start();
  return worker;
}

afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.dispose()));
});

describe("PiRpcProcess", () => {
  it("uses the required read-only Pi startup flags", () => {
    expect(buildPiArguments("/private/sessions")).toEqual([
      "--mode",
      "rpc",
      "--no-approve",
      "--no-extensions",
      "--no-skills",
      "--no-context-files",
      "--tools",
      "read,grep,find,ls",
      "--session-dir",
      "/private/sessions",
    ]);
  });

  it("accepts a prompt, settles, and retrieves the completed assistant text", async () => {
    const worker = await createWorker();
    const settled = new Promise<void>((resolve) => {
      worker.onEvent((event) => {
        if (event.type === "agent_settled") resolve();
      });
    });

    await expect(worker.prompt("explain the test")).resolves.toBeUndefined();
    await settled;
    await expect(worker.getLastAssistantText()).resolves.toBe(
      "Fake Pi completed: explain the test",
    );
  });

  it("reports the start of each thinking block without exposing its text", async () => {
    const worker = await createWorker();
    const events: string[] = [];
    const thinking = new Promise<void>((resolve) => {
      worker.onEvent((event) => {
        events.push(event.type);
        if (event.type === "thinking_started") resolve();
      });
    });

    await worker.prompt("explain the test");
    await thinking;

    expect(events).toContain("thinking_started");
  });

  it("changes models and exposes the available thinking levels", async () => {
    const worker = await createWorker();

    await expect(worker.getState()).resolves.toMatchObject({
      model: { provider: "openai-codex", id: "gpt-5.6-luna" },
      thinkingLevel: "max",
    });
    await expect(worker.getAvailableThinkingLevels()).resolves.toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);

    await worker.setModel("openai-codex", "gpt-5.6-sol");
    await worker.setThinkingLevel("high");

    await expect(worker.getState()).resolves.toMatchObject({
      model: { provider: "openai-codex", id: "gpt-5.6-sol" },
      thinkingLevel: "high",
    });
  });

  it("keeps Unicode separators inside the final text", async () => {
    const worker = await createWorker();
    const settled = new Promise<void>((resolve) => {
      worker.onEvent((event) => {
        if (event.type === "agent_settled") resolve();
      });
    });

    await worker.prompt("__unicode__");
    await settled;

    await expect(worker.getLastAssistantText()).resolves.toBe(
      "line one\u2028line two\u2029done",
    );
  });

  it("aborts an active prompt and can create a new session", async () => {
    const worker = await createWorker();
    await worker.prompt("__hang__");

    await expect(worker.abort()).resolves.toBeUndefined();
    await expect(worker.newSession()).resolves.toBe("fake-session-2");
  });

  it("reports stderr without parsing it as RPC output", async () => {
    const stderr: string[] = [];
    const worker = await createWorker({ stderr: (text) => stderr.push(text) });
    const settled = new Promise<void>((resolve) => {
      worker.onEvent((event) => {
        if (event.type === "agent_settled") resolve();
      });
    });

    await worker.prompt("__stderr__");
    await settled;

    expect(stderr.join("")).toContain("fake diagnostic only");
    await expect(worker.getLastAssistantText()).resolves.toContain(
      "__stderr__",
    );
  });

  it("fails pending work when the child exits", async () => {
    const worker = await createWorker();
    await worker.prompt("__exit__");

    await expect(worker.waitForExit()).rejects.toBeInstanceOf(
      PiRpcProcessExitError,
    );
  });

  it("fails the worker on malformed stdout", async () => {
    const worker = await createWorker();
    const failure = worker.waitForExit();
    await worker.prompt("__malformed__");

    await expect(failure).rejects.toBeInstanceOf(PiRpcProtocolError);
  });

  it("fails the worker on a malformed correlated response", async () => {
    const worker = await createWorker();

    await expect(worker.prompt("__invalid_response__")).rejects.toBeInstanceOf(
      PiRpcProtocolError,
    );
  });

  it("forces a child to exit when graceful shutdown is ignored", async () => {
    const worker = await createWorker({ ignoreTermination: true });
    const startedAt = Date.now();

    await worker.dispose();

    expect(Date.now() - startedAt).toBeLessThan(5_000);
    await expect(worker.waitForExit()).resolves.toBeUndefined();
  });

  it("sends only the allowed command set to the child", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-dalamud-command-log-"));
    const commandLog = join(directory, "commands.txt");
    const worker = await createWorker({ commandLog });
    const settled = new Promise<void>((resolve) => {
      worker.onEvent((event) => {
        if (event.type === "agent_settled") resolve();
      });
    });

    await worker.prompt("allowed");
    await settled;
    await worker.getLastAssistantText();
    await worker.getState();
    await worker.newSession();
    await worker.setModel("openai-codex", "gpt-5.6-sol");
    await worker.setThinkingLevel("high");
    await worker.getAvailableThinkingLevels();

    const commands = (await readFile(commandLog, "utf8")).trim().split("\n");
    expect(new Set(commands)).toEqual(
      new Set([
        "get_state",
        "prompt",
        "get_last_assistant_text",
        "new_session",
        "set_model",
        "set_thinking_level",
        "get_available_thinking_levels",
      ]),
    );
    expect(commands).not.toContain("bash");
  });
});
