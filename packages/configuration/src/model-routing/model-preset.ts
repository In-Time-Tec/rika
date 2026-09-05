import type { ModelRoute } from "./model-route"
import { catalog, supportedEfforts } from "./model-catalog"

type CatalogModel = (typeof catalog)[keyof typeof catalog]

const openAiEfforts = {
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "xhigh",
} satisfies Readonly<Record<ModelRoute.Effort, string>>

const astraEfforts = {
  ...openAiEfforts,
  max: "max",
} satisfies Readonly<Record<ModelRoute.Effort, string>>

const claudeEfforts = {
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "max",
  max: "max",
} satisfies Readonly<Record<ModelRoute.Effort, string>>

const gptVariants = (
  efforts: ReadonlyArray<ModelRoute.Effort>,
  providerEfforts: Readonly<Record<ModelRoute.Effort, string>> = openAiEfforts,
): ModelRoute.ModelAlias["variants"] =>
  Object.fromEntries(
    efforts.map((effort) => {
      const reasoning = { effort: providerEfforts[effort], summary: "auto" }
      return [
        effort,
        {
          normal: { options: { reasoning } },
          fast: { options: { reasoning, service_tier: "priority" } },
        },
      ]
    }),
  )

const claudeVariants = (efforts: ReadonlyArray<ModelRoute.Effort>): ModelRoute.ModelAlias["variants"] =>
  Object.fromEntries(
    efforts.map((effort) => [effort, { normal: { options: { output_config: { effort: claudeEfforts[effort] } } } }]),
  )

export const presetIds = ["openai", "claude"] as const
export type PresetId = (typeof presetIds)[number]

interface ModelPreset {
  readonly protocols: ReadonlyArray<ModelRoute.ProviderConnection["protocol"]>
  readonly optionKeys: ReadonlyArray<string>
  readonly efforts: ReadonlyArray<ModelRoute.Effort>
  readonly limits: ModelRoute.ModelAlias["limits"]
  readonly variants: (efforts: ReadonlyArray<ModelRoute.Effort>) => ModelRoute.ModelAlias["variants"]
}

export const presets = {
  openai: {
    protocols: Array<ModelRoute.ProviderConnection["protocol"]>(
      "openai-responses",
      "openai-chat-completions",
      "openrouter",
    ),
    optionKeys: ["reasoning", "service_tier"],
    efforts: supportedEfforts,
    limits: { contextWindow: 272_000, maxInputTokens: 258_400, maxOutputTokens: 128_000, keepRecentTokens: 32_000 },
    variants: gptVariants,
  },
  claude: {
    protocols: Array<ModelRoute.ProviderConnection["protocol"]>("anthropic", "amazon-bedrock"),
    optionKeys: ["output_config"],
    efforts: supportedEfforts,
    limits: { maxInputTokens: 872_000, maxOutputTokens: 128_000, keepRecentTokens: 64_000 },
    variants: claudeVariants,
  },
} satisfies Readonly<Record<PresetId, ModelPreset>>

const limits = (model: CatalogModel, keepRecentTokens: number) => ({
  contextWindow: model.limits.contextWindow,
  maxInputTokens: model.limits.maxInputTokens,
  maxOutputTokens: model.limits.maxOutputTokens,
  keepRecentTokens,
})

const gpt = (
  model: CatalogModel,
  providerEfforts: Readonly<Record<ModelRoute.Effort, string>> = openAiEfforts,
): ModelRoute.ModelAlias => ({
  displayName: model.displayName,
  supportsMedia: true,
  provider: "openai",
  candidates: [model.id],
  limits: limits(model, presets.openai.limits.keepRecentTokens),
  variants: gptVariants(model.efforts, providerEfforts),
})

const claude = (model: CatalogModel, candidates: ReadonlyArray<string>): ModelRoute.ModelAlias => ({
  displayName: model.displayName,
  supportsMedia: true,
  provider: "anthropic",
  candidates,
  limits: limits(model, presets.claude.limits.keepRecentTokens),
  variants: claudeVariants(model.efforts),
})

export const builtInAliases = {
  luna: gpt(catalog.gpt56Luna),
  terra: gpt(catalog.gpt56Terra),
  sol: gpt(catalog.gpt56Sol),
  astra: gpt(catalog.gpt6Astra, astraEfforts),
  fable: claude(catalog.claudeFable5, [catalog.claudeFable5.id, catalog.claudeOpus48.id]),
  opus5: claude(catalog.claudeOpus5, [catalog.claudeOpus5.id, catalog.claudeFable5.id]),
  opus: claude(catalog.claudeOpus48, [catalog.claudeOpus48.id]),
} satisfies Readonly<Record<string, ModelRoute.ModelAlias>>

export const defaultCompaction = {
  contextWindow: catalog.gpt56Luna.limits.contextWindow,
  reserveTokens: catalog.gpt56Luna.limits.contextWindow - catalog.gpt56Luna.limits.maxInputTokens,
  keepRecentTokens: 32_000,
}
