import type { Effort, ModelAlias } from "./config-contract"

const source = "https://models.dev"

export const supportedEfforts = ["low", "medium", "high", "xhigh", "max"] as const satisfies ReadonlyArray<Effort>

export const catalog = {
  gpt56Luna: {
    source,
    id: "gpt-5.6-luna",
    displayName: "GPT-5.6 Luna",
    limits: { contextWindow: 1_050_000, maxInputTokens: 922_000, maxOutputTokens: 128_000 },
    efforts: supportedEfforts,
  },
  gpt56Terra: {
    source,
    id: "gpt-5.6-terra",
    displayName: "GPT-5.6 Terra",
    limits: { contextWindow: 1_050_000, maxInputTokens: 922_000, maxOutputTokens: 128_000 },
    efforts: supportedEfforts,
  },
  gpt56Sol: {
    source,
    id: "gpt-5.6-sol",
    displayName: "GPT-5.6 Sol",
    limits: { contextWindow: 1_050_000, maxInputTokens: 922_000, maxOutputTokens: 128_000 },
    efforts: supportedEfforts,
  },
  gpt55: {
    source,
    id: "gpt-5.5",
    displayName: "GPT-5.5",
    limits: { contextWindow: 1_050_000, maxInputTokens: 922_000, maxOutputTokens: 128_000 },
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

type CatalogModel = (typeof catalog)[keyof typeof catalog]

const gptVariants = (efforts: ReadonlyArray<string>) =>
  Object.fromEntries(
    efforts.map((effort) => [
      effort,
      {
        normal: { options: { reasoning: { effort, summary: "auto" } } },
        fast: { options: { reasoning: { effort, summary: "auto" }, service_tier: "priority" } },
      },
    ]),
  ) as ModelAlias["variants"]

const claudeVariants = (efforts: ReadonlyArray<string>) =>
  Object.fromEntries(
    efforts.map((effort) => [effort, { normal: { options: { output_config: { effort } } } }]),
  ) as ModelAlias["variants"]

export const presetIds = ["openai", "claude"] as const
export type PresetId = (typeof presetIds)[number]

export const presets = {
  openai: {
    protocols: ["openai"] as ReadonlyArray<string>,
    optionKeys: ["reasoning", "service_tier"] as ReadonlyArray<string>,
    efforts: supportedEfforts as ReadonlyArray<Effort>,
    limits: { maxInputTokens: 922_000, maxOutputTokens: 128_000, keepRecentTokens: 32_000 },
    variants: gptVariants,
  },
  claude: {
    protocols: ["anthropic", "amazon-bedrock"] as ReadonlyArray<string>,
    optionKeys: ["output_config"] as ReadonlyArray<string>,
    efforts: supportedEfforts as ReadonlyArray<Effort>,
    limits: { maxInputTokens: 872_000, maxOutputTokens: 128_000, keepRecentTokens: 64_000 },
    variants: claudeVariants,
  },
} as const satisfies Readonly<Record<PresetId, unknown>>

const limits = (model: CatalogModel, keepRecentTokens: number) => ({
  maxInputTokens: model.limits.maxInputTokens,
  maxOutputTokens: model.limits.maxOutputTokens,
  keepRecentTokens,
})

const gpt = (model: CatalogModel): ModelAlias => ({
  displayName: model.displayName,
  supportsMedia: true,
  provider: "openai",
  candidates: [model.id],
  limits: limits(model, presets.openai.limits.keepRecentTokens),
  variants: gptVariants(model.efforts),
})

const claude = (model: CatalogModel, candidates: ReadonlyArray<string>): ModelAlias => ({
  displayName: model.displayName,
  supportsMedia: true,
  provider: "anthropic",
  candidates,
  limits: limits(model, presets.claude.limits.keepRecentTokens),
  variants: claudeVariants(model.efforts),
})

export const defaults = {
  luna: gpt(catalog.gpt56Luna),
  terra: gpt(catalog.gpt56Terra),
  sol: gpt(catalog.gpt56Sol),
  review: gpt(catalog.gpt55),
  fable: claude(catalog.claudeFable5, [catalog.claudeFable5.id, catalog.claudeOpus48.id]),
  opus5: claude(catalog.claudeOpus5, [catalog.claudeOpus5.id, catalog.claudeFable5.id]),
  opus: claude(catalog.claudeOpus48, [catalog.claudeOpus48.id]),
} satisfies Readonly<Record<string, ModelAlias>>

export const presetForBase = (base: string): PresetId => (base === "fable" || base === "opus" ? "claude" : "openai")

export const defaultCompaction = {
  contextWindow: catalog.gpt56Luna.limits.contextWindow,
  reserveTokens: catalog.gpt56Luna.limits.maxOutputTokens,
  keepRecentTokens: 32_000,
}
