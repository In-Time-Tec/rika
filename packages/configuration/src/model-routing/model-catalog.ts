import type { ModelRoute } from "./model-route"

const source = "https://models.dev"

export const supportedEfforts = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies ReadonlyArray<ModelRoute.Effort>

export const catalog = {
  gpt56Luna: {
    source,
    id: "gpt-5.6-luna",
    displayName: "GPT-5.6 Luna",
    limits: { contextWindow: 272_000, maxInputTokens: 258_400, maxOutputTokens: 128_000 },
    efforts: supportedEfforts,
  },
  gpt56Terra: {
    source,
    id: "gpt-5.6-terra",
    displayName: "GPT-5.6 Terra",
    limits: { contextWindow: 272_000, maxInputTokens: 258_400, maxOutputTokens: 128_000 },
    efforts: supportedEfforts,
  },
  gpt56Sol: {
    source,
    id: "gpt-5.6-sol",
    displayName: "GPT-5.6 Sol",
    limits: { contextWindow: 272_000, maxInputTokens: 258_400, maxOutputTokens: 128_000 },
    efforts: supportedEfforts,
  },
  gpt6Astra: {
    source: "https://developers.openai.com/api/docs/models/gpt-6-astra",
    id: "gpt-6-astra",
    displayName: "GPT-6 Astra",
    limits: { contextWindow: 1_050_000, maxInputTokens: 922_000, maxOutputTokens: 128_000 },
    efforts: supportedEfforts,
  },
  gpt55: {
    source,
    id: "gpt-5.5",
    displayName: "GPT-5.5",
    limits: { contextWindow: 272_000, maxInputTokens: 258_400, maxOutputTokens: 128_000 },
    efforts: ["low", "medium", "high", "xhigh"],
  },
  claudeFable5: {
    source,
    id: "claude-fable-5",
    displayName: "Claude Fable 5",
    limits: { contextWindow: 1_000_000, maxInputTokens: 872_000, maxOutputTokens: 128_000 },
    efforts: supportedEfforts,
  },
  claudeOpus5: {
    source,
    id: "claude-opus-5",
    displayName: "Claude Opus 5",
    limits: { contextWindow: 1_000_000, maxInputTokens: 872_000, maxOutputTokens: 128_000 },
    efforts: supportedEfforts,
  },
  claudeOpus48: {
    source,
    id: "claude-opus-4-8",
    displayName: "Claude Opus 4.8",
    limits: { contextWindow: 1_000_000, maxInputTokens: 872_000, maxOutputTokens: 128_000 },
    efforts: supportedEfforts,
  },
} as const
