import { z } from "zod";

import {
  modelPresetSchema,
  thinkingLevelSchema,
  type ModelPreset,
  type ThinkingLevel,
} from "./model-presets.js";

export const PROTOCOL_VERSION = 1 as const;
export const MAX_FRAME_BYTES = 64 * 1024;

const envelope = {
  version: z.literal(PROTOCOL_VERSION),
};

const requestIdSchema = z.uuid();

const promptSchema = z
  .strictObject({
    ...envelope,
    type: z.literal("prompt"),
    requestId: requestIdSchema,
    text: z.string().transform((text) => text.trim()),
  })
  .refine(({ text }) => [...text].length >= 1 && [...text].length <= 16_000, {
    message: "text must contain 1 to 16000 characters after trimming",
    path: ["text"],
  });

const abortSchema = z.strictObject({
  ...envelope,
  type: z.literal("abort"),
  requestId: requestIdSchema,
});

const getStatusSchema = z.strictObject({
  ...envelope,
  type: z.literal("get_status"),
});

const newSessionSchema = z.strictObject({
  ...envelope,
  type: z.literal("new_session"),
});

const selectModelSchema = z.strictObject({
  ...envelope,
  type: z.literal("select_model"),
  preset: modelPresetSchema,
});

const setThinkingLevelSchema = z.strictObject({
  ...envelope,
  type: z.literal("set_thinking_level"),
  level: thinkingLevelSchema,
});

export const pluginMessageSchema = z.discriminatedUnion("type", [
  promptSchema,
  abortSchema,
  getStatusSchema,
  newSessionSchema,
  selectModelSchema,
  setThinkingLevelSchema,
]);

export type PluginMessage = z.infer<typeof pluginMessageSchema>;

export type BridgeState = "starting" | "idle" | "running" | "error";

export type BridgeErrorCode =
  | "unauthorized"
  | "invalid_message"
  | "message_too_large"
  | "busy"
  | "request_not_active"
  | "pi_start_failed"
  | "pi_exited"
  | "pi_prompt_failed"
  | "pi_abort_failed"
  | "session_switch_failed"
  | "model_switch_failed"
  | "thinking_level_failed"
  | "internal_error";

export type ModelState = {
  readonly preset: ModelPreset | null;
  readonly provider: string | null;
  readonly modelId: string | null;
  readonly thinkingLevel: ThinkingLevel | null;
  readonly availableThinkingLevels: readonly ThinkingLevel[];
};

export type BridgeMessage =
  | {
      readonly version: 1;
      readonly type: "ready";
      readonly sessionId: string;
      readonly state: "idle";
    }
  | {
      readonly version: 1;
      readonly type: "accepted";
      readonly requestId: string;
    }
  | {
      readonly version: 1;
      readonly type: "settled";
      readonly requestId: string;
      readonly sessionId: string;
      readonly text: string;
    }
  | {
      readonly version: 1;
      readonly type: "status";
      readonly state: BridgeState;
      readonly sessionId: string;
      readonly activeRequestId?: string;
    }
  | {
      readonly version: 1;
      readonly type: "aborted";
      readonly requestId: string;
    }
  | {
      readonly version: 1;
      readonly type: "model_state";
      readonly preset: ModelPreset | null;
      readonly provider: string | null;
      readonly modelId: string | null;
      readonly thinkingLevel: ThinkingLevel | null;
      readonly availableThinkingLevels: readonly ThinkingLevel[];
    }
  | {
      readonly version: 1;
      readonly type: "error";
      readonly code: BridgeErrorCode;
      readonly message: string;
      readonly requestId?: string;
    };

export function parsePluginMessage(input: string): PluginMessage {
  if (Buffer.byteLength(input, "utf8") > MAX_FRAME_BYTES) {
    throw new ProtocolMessageError(
      "message_too_large",
      "Message exceeds 64 KiB",
    );
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(input);
  } catch {
    throw new ProtocolMessageError(
      "invalid_message",
      "Message is not valid JSON",
    );
  }

  const result = pluginMessageSchema.safeParse(decoded);
  if (!result.success) {
    throw new ProtocolMessageError(
      "invalid_message",
      "Message does not match protocol v1",
    );
  }

  return result.data;
}

export class ProtocolMessageError extends Error {
  public constructor(
    public readonly code: "invalid_message" | "message_too_large",
    message: string,
  ) {
    super(message);
    this.name = "ProtocolMessageError";
  }
}
