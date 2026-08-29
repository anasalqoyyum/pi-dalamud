import { describe, expect, it } from "vitest";

import {
  JsonlRecordParser,
  PiRpcProtocolError,
} from "../src/pi-rpc-process.js";

describe("strict Pi JSONL framing", () => {
  it("joins a fragmented record", () => {
    const parser = new JsonlRecordParser();

    expect(parser.push(Buffer.from('{"type":"agent_'))).toEqual([]);
    expect(parser.push(Buffer.from('settled"}\n'))).toEqual([
      { type: "agent_settled" },
    ]);
  });

  it("returns several records from one chunk", () => {
    const parser = new JsonlRecordParser();

    expect(parser.push(Buffer.from('{"a":1}\n{"b":2}\n'))).toEqual([
      { a: 1 },
      { b: 2 },
    ]);
  });

  it("strips CR only when it immediately precedes LF", () => {
    const parser = new JsonlRecordParser();

    expect(parser.push(Buffer.from('{"text":"ok"}\r\n'))).toEqual([
      { text: "ok" },
    ]);
  });

  it("preserves Unicode line separators inside JSON strings", () => {
    const parser = new JsonlRecordParser();

    expect(
      parser.push(Buffer.from('{"text":"one\u2028two\u2029three"}\n')),
    ).toEqual([{ text: "one\u2028two\u2029three" }]);
  });

  it("rejects malformed JSON", () => {
    const parser = new JsonlRecordParser();

    expect(() => parser.push(Buffer.from("{bad}\n"))).toThrow(
      PiRpcProtocolError,
    );
  });

  it("rejects an unterminated record at EOF", () => {
    const parser = new JsonlRecordParser();
    parser.push(Buffer.from('{"partial":true}'));

    expect(() => parser.finish()).toThrow(PiRpcProtocolError);
  });
});
