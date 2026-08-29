import { appendFileSync } from "node:fs";

let buffer = Buffer.alloc(0);
let sessionNumber = 1;
let lastAssistantText = null;
let active = false;

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

function handle(command) {
  recordCommand(command);

  switch (command.type) {
    case "get_state":
      respond(command, true, {
        isStreaming: active,
        sessionId: `fake-session-${sessionNumber}`,
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
        send({ type: "agent_settled" });
        setTimeout(() => respond(command, true), 5);
        break;
      }

      respond(command, true);

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
