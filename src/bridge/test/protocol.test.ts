import { describe, expect, it } from "vitest";

import {
  MAX_FRAME_BYTES,
  ProtocolMessageError,
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
