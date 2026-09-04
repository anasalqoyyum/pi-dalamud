import { describe, expect, it } from "vitest";

import {
  MAX_FRAME_BYTES,
  SETTLED_TRUNCATION_MARKER,
  ProtocolMessageError,
  buildSettledMessage,
  parsePluginMessage,
} from "../src/protocol.js";

describe("plugin protocol v1", () => {
  it("parses and trims a valid prompt", () => {
    expect(
      parsePluginMessage(
        JSON.stringify({
          version: 1,
          type: "prompt",
          requestId: "3f0426b1-838c-4d47-8ac8-787178856bef",
          text: "  explain this  ",
        }),
      ),
    ).toEqual({
      version: 1,
      type: "prompt",
      requestId: "3f0426b1-838c-4d47-8ac8-787178856bef",
      text: "explain this",
    });
  });

  it("parses the fixed model presets and thinking levels", () => {
    expect(
      parsePluginMessage(
        JSON.stringify({ version: 1, type: "select_model", preset: "luna" }),
      ),
    ).toEqual({ version: 1, type: "select_model", preset: "luna" });
    expect(
      parsePluginMessage(
        JSON.stringify({
          version: 1,
          type: "set_thinking_level",
          level: "off",
        }),
      ),
    ).toEqual({
      version: 1,
      type: "set_thinking_level",
      level: "off",
    });
  });

  it.each([
    ["unknown message", { version: 1, type: "bash", command: "id" }],
    [
      "unknown model preset",
      { version: 1, type: "select_model", preset: "other" },
    ],
    [
      "unknown thinking level",
      { version: 1, type: "set_thinking_level", level: "extreme" },
    ],
    ["wrong version", { version: 2, type: "get_status" }],
    ["unknown field", { version: 1, type: "get_status", command: "bash" }],
    [
      "blank prompt",
      {
        version: 1,
        type: "prompt",
        requestId: crypto.randomUUID(),
        text: "  ",
      },
    ],
  ])("rejects %s", (_name, value) => {
    expect(() => parsePluginMessage(JSON.stringify(value))).toThrow(
      ProtocolMessageError,
    );
  });

  it("rejects a frame larger than 64 KiB", () => {
    const oversized = "x".repeat(MAX_FRAME_BYTES + 1);

    expect(() => parsePluginMessage(oversized)).toThrow(
      expect.objectContaining({ code: "message_too_large" }),
    );
  });

  it("counts Unicode scalar values rather than UTF-16 code units", () => {
    const text = "😀".repeat(16_000);

    expect(
      parsePluginMessage(
        JSON.stringify({
          version: 1,
          type: "prompt",
          requestId: crypto.randomUUID(),
          text,
        }),
      ),
    ).toMatchObject({ text });
  });
});

describe("settled frame limit", () => {
  const requestId = crypto.randomUUID();

  it("returns the response unchanged when it fits one frame", () => {
    const { message, truncated } = buildSettledMessage(
      requestId,
      "fake-session-1",
      "hello",
    );

    expect(truncated).toBe(false);
    expect(message).toEqual({
      version: 1,
      type: "settled",
      requestId,
      sessionId: "fake-session-1",
      text: "hello",
    });
  });

  it("truncates an oversized response and appends the marker", () => {
    const { message, truncated } = buildSettledMessage(
      requestId,
      "fake-session-1",
      "y".repeat(MAX_FRAME_BYTES),
    );

    expect(truncated).toBe(true);
    expect(message.text.startsWith("yyyy")).toBe(true);
    expect(message.text.endsWith(SETTLED_TRUNCATION_MARKER)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(message), "utf8"))
      .toBeLessThanOrEqual(MAX_FRAME_BYTES);
  });

  it("charges JSON escapes to the byte budget", () => {
    const { message, truncated } = buildSettledMessage(
      requestId,
      "fake-session-1",
      '\n"😀'.repeat(MAX_FRAME_BYTES),
    );

    expect(truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(message), "utf8"))
      .toBeLessThanOrEqual(MAX_FRAME_BYTES);
  });

  it("cuts on code point boundaries, never mid surrogate pair", () => {
    const { message } = buildSettledMessage(
      requestId,
      "fake-session-1",
      "😀".repeat(MAX_FRAME_BYTES),
    );
    const body = message.text.slice(
      0,
      message.text.length - SETTLED_TRUNCATION_MARKER.length,
    );
    const tail = body.charCodeAt(body.length - 1);
    const beforeTail = body.charCodeAt(body.length - 2);
    const endsWithLoneSurrogate =
      (tail >= 0xd800 && tail <= 0xdbff) ||
      (tail >= 0xdc00 && tail <= 0xdfff && !(beforeTail >= 0xd800 && beforeTail <= 0xdbff));

    expect(endsWithLoneSurrogate).toBe(false);
  });

  it("accounts for the session id length in the frame budget", () => {
    const { message, truncated } = buildSettledMessage(
      requestId,
      "s".repeat(2_000),
      "y".repeat(MAX_FRAME_BYTES),
    );

    expect(truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(message), "utf8"))
      .toBeLessThanOrEqual(MAX_FRAME_BYTES);
  });
});
