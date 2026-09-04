import { appendFileSync } from "node:fs";

let buffer = Buffer.alloc(0);
let sessionNumber = 1;
let lastAssistantText = null;
let active = false;
let currentModel = { provider: "openai-codex", id: "gpt-5.6-luna" };
let thinkingLevel = "max";

const thinkingLevelsByModel = {
  "gpt-5.6-luna": ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
  "gpt-5.6-sol": ["off", "minimal", "low", "medium", "high"],
};

if (process.env.FAKE_PI_IGNORE_TERM === "1") {
  process.on("SIGTERM", () => undefined);
}

function recordCommand(command) {
  const path = process.env.FAKE_PI_COMMAND_LOG;
  if (path) {
    appendFileSync(path, `${command.type}\n`, { encoding: "utf8" });
  }
}

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function respond(command, success, data, error) {
  const response = {
    id: command.id,
    type: "response",
    command: command.type,
    success,
  };

  if (data !== undefined) {
    response.data = data;
  }

  if (error !== undefined) {
    response.error = error;
  }

  send(response);
}

function sendThinking() {
  send({
    type: "message_update",
    assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
  });
}

function handle(command) {
  recordCommand(command);

  switch (command.type) {
    case "get_state":
      respond(command, true, {
        isStreaming: active,
        sessionId: `fake-session-${sessionNumber}`,
        model: currentModel,
        thinkingLevel,
      });
      break;
    case "set_model":
      if (
        command.provider !== "openai-codex" ||
        !thinkingLevelsByModel[command.modelId]
      ) {
        respond(command, false, undefined, "unsupported model");
        break;
      }

      currentModel = { provider: command.provider, id: command.modelId };
      respond(command, true, { model: currentModel });
      break;
    case "set_thinking_level": {
      const available = thinkingLevelsByModel[currentModel.id] ?? ["off"];
      if (!available.includes(command.level)) {
        respond(command, false, undefined, "unsupported thinking level");
        break;
      }

      thinkingLevel = command.level;
      respond(command, true);
      break;
    }
    case "get_available_thinking_levels":
      respond(command, true, {
        levels: thinkingLevelsByModel[currentModel.id] ?? ["off"],
      });
      break;
    case "prompt": {
      active = true;
      if (command.message === "__invalid_response__") {
        send({ id: command.id, type: "response", command: "prompt" });
        break;
      }

      if (command.message === "__reject__") {
        active = false;
        respond(command, false, undefined, "prompt rejected");
        break;
      }

      if (command.message === "__settle_before_accept__") {
        active = false;
        lastAssistantText = "settled before acceptance";
        sendThinking();
        send({ type: "agent_settled" });
        setTimeout(() => respond(command, true), 5);
        break;
      }

      respond(command, true);
      sendThinking();

      if (command.message === "__hang__") {
        break;
      }

      if (command.message === "__exit__") {
        setTimeout(() => process.exit(23), 5);
        break;
      }

      if (command.message === "__malformed__") {
        setTimeout(() => process.stdout.write("{not-json}\n"), 5);
        break;
      }

      if (command.message === "__stderr__") {
        process.stderr.write("fake diagnostic only\n");
      }

      if (command.message === "__oversized__") {
        lastAssistantText = `oversized head ${"y".repeat(70_000)} oversized tail`;
        setTimeout(() => {
          active = false;
          send({ type: "agent_settled" });
        }, 5);
        break;
      }

      lastAssistantText =
        command.message === "__unicode__"
          ? "line one\u2028line two\u2029done"
          : `Fake Pi completed: ${command.message}`;

      setTimeout(() => {
        active = false;
        send({ type: "agent_settled" });
      }, 5);
      break;
    }
    case "get_last_assistant_text":
      respond(command, true, { text: lastAssistantText });
      break;
    case "abort":
      active = false;
      send({ type: "agent_settled" });
      respond(command, true);
      break;
    case "new_session":
      sessionNumber += 1;
      lastAssistantText = null;
      respond(command, true, { cancelled: false });
      break;
    default:
      respond(command, false, undefined, "unsupported command");
  }
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);

  while (true) {
    const lfIndex = buffer.indexOf(0x0a);
    if (lfIndex < 0) {
      break;
    }

    let record = buffer.subarray(0, lfIndex);
    buffer = buffer.subarray(lfIndex + 1);
    if (record.at(-1) === 0x0d) {
      record = record.subarray(0, -1);
    }

    if (record.length > 0) {
      handle(JSON.parse(record.toString("utf8")));
    }
  }
});
