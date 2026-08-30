import { z } from "zod";

export const thinkingLevelSchema = z.enum([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export type ThinkingLevel = z.infer<typeof thinkingLevelSchema>;

export const modelPresetNames = ["luna", "sol"] as const;
export const modelPresetSchema = z.enum(modelPresetNames);
export type ModelPreset = z.infer<typeof modelPresetSchema>;

type ModelPresetDefinition = {
  readonly label: string;
  readonly provider: string;
  readonly modelId: string;
  readonly defaultThinkingLevel: ThinkingLevel;
};

export const modelPresets = {
  luna: {
    label: "GPT-5.6 Luna",
    provider: "openai-codex",
    modelId: "gpt-5.6-luna",
    defaultThinkingLevel: "max",
  },
  sol: {
    label: "GPT-5.6 Sol",
    provider: "openai-codex",
    modelId: "gpt-5.6-sol",
    defaultThinkingLevel: "high",
  },
} satisfies Record<ModelPreset, ModelPresetDefinition>;

export function findModelPreset(
  provider: string,
  modelId: string,
): ModelPreset | null {
  for (const preset of modelPresetNames) {
    const definition = modelPresets[preset];
    if (definition.provider === provider && definition.modelId === modelId) {
      return preset;
    }
  }

  return null;
}
