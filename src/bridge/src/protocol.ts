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

export type SettledMessage = Extract<
  BridgeMessage,
  { readonly type: "settled" }
>;

/**
 * Appended to `settled` text when a completed response does not fit one frame.
 * Documented verbatim in docs/protocol-v1.md.
 */
export const SETTLED_TRUNCATION_MARKER =
  "\n[Response truncated to fit the bridge message size limit]";

/**
 * Build the `settled` message for a completed response. Pi responses have no
 * fixed length, so when the serialized frame would exceed the protocol limit
 * the text is cut to the longest code-point-aligned prefix that fits and the
 * truncation marker is appended. This keeps every outbound frame within the
 * limit the plugin's receive loop enforces.
 */
export function buildSettledMessage(
  requestId: string,
  sessionId: string,
  text: string,
): { readonly message: SettledMessage; readonly truncated: boolean } {
  const envelope = {
    version: PROTOCOL_VERSION,
    type: "settled" as const,
    requestId,
    sessionId,
  };
  // Key order matches the returned message, so this measures the exact bytes
  // `send()` will serialize. The two bytes quoted here belong to the text
  // field, which the budget below replaces.
  const fixed = JSON.stringify({ ...envelope, text: "" });
  const textBudget =
    MAX_FRAME_BYTES - Buffer.byteLength(fixed, "utf8") + 2;

  if (Buffer.byteLength(JSON.stringify(text), "utf8") <= textBudget) {
    return { message: { ...envelope, text }, truncated: false };
  }

  // JSON escaping is per character, so the serialized size of prefix + marker
  // is the sum of their sizes minus one pair of quotes.
  const markerSize = Buffer.byteLength(
    JSON.stringify(SETTLED_TRUNCATION_MARKER),
    "utf8",
  );
  return {
    message: {
      ...envelope,
      text: `${truncateWithinJsonBudget(text, textBudget - markerSize + 2)}${SETTLED_TRUNCATION_MARKER}`,
    },
    truncated: true,
  };
}

function truncateWithinJsonBudget(text: string, budget: number): string {
  // Longest code-point-aligned prefix whose JSON serialization, including the
  // surrounding quotes, fits the byte budget. Only the truncation path pays
  // the per-code-point cost.
  let used = 2;
  let end = 0;
  for (const unit of Array.from(text)) {
    const size = Buffer.byteLength(JSON.stringify(unit), "utf8") - 2;
    if (used + size > budget) break;
    used += size;
    end += unit.length;
  }

  return text.slice(0, end);
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
