import type { ModelRoute } from "./model-route"
import { catalog, supportedEfforts } from "./model-catalog"

type CatalogModel = (typeof catalog)[keyof typeof catalog]

const openAiEfforts: Readonly<Record<ModelRoute.Effort, string>> = {
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "xhigh",
}

const claudeEfforts: Readonly<Record<ModelRoute.Effort, string>> = {
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "max",
  max: "max",
}

const gptVariants = (efforts: ReadonlyArray<string>) =>
  Object.fromEntries(
    efforts.map((effort) => {
      const reasoning = { effort: openAiEfforts[effort as ModelRoute.Effort], summary: "auto" }
      return [
        effort,
        {
          normal: { options: { reasoning } },
          fast: { options: { reasoning, service_tier: "priority" } },
        },
      ]
    }),
  ) as ModelRoute.ModelAlias["variants"]

const claudeVariants = (efforts: ReadonlyArray<string>) =>
  Object.fromEntries(
    efforts.map((effort) => [
      effort,
      { normal: { options: { output_config: { effort: claudeEfforts[effort as ModelRoute.Effort] } } } },
    ]),
  ) as ModelRoute.ModelAlias["variants"]

export const presetIds = ["openai", "claude"] as const
export type PresetId = (typeof presetIds)[number]

export const presets = {
  openai: {
    protocols: ["openai", "openrouter"] as ReadonlyArray<string>,
    optionKeys: ["reasoning", "service_tier"] as ReadonlyArray<string>,
    efforts: supportedEfforts as ReadonlyArray<ModelRoute.Effort>,
    limits: { contextWindow: 272_000, maxInputTokens: 258_400, maxOutputTokens: 128_000, keepRecentTokens: 32_000 },
    variants: gptVariants,
  },
  claude: {
    protocols: ["anthropic", "amazon-bedrock"] as ReadonlyArray<string>,
    optionKeys: ["output_config"] as ReadonlyArray<string>,
    efforts: supportedEfforts as ReadonlyArray<ModelRoute.Effort>,
    limits: { maxInputTokens: 872_000, maxOutputTokens: 128_000, keepRecentTokens: 64_000 },
    variants: claudeVariants,
  },
} as const satisfies Readonly<Record<PresetId, unknown>>

const limits = (model: CatalogModel, keepRecentTokens: number) => ({
  contextWindow: model.limits.contextWindow,
  maxInputTokens: model.limits.maxInputTokens,
  maxOutputTokens: model.limits.maxOutputTokens,
  keepRecentTokens,
})

const gpt = (model: CatalogModel): ModelRoute.ModelAlias => ({
  displayName: model.displayName,
  supportsMedia: true,
  provider: "openai",
  candidates: [model.id],
  limits: limits(model, presets.openai.limits.keepRecentTokens),
  variants: gptVariants(model.efforts),
})

const claude = (model: CatalogModel, candidates: ReadonlyArray<string>): ModelRoute.ModelAlias => ({
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
  fable: claude(catalog.claudeFable5, [catalog.claudeFable5.id, catalog.claudeOpus48.id]),
  opus5: claude(catalog.claudeOpus5, [catalog.claudeOpus5.id, catalog.claudeFable5.id]),
  opus: claude(catalog.claudeOpus48, [catalog.claudeOpus48.id]),
} satisfies Readonly<Record<string, ModelRoute.ModelAlias>>

export const defaultCompaction = {
  contextWindow: catalog.gpt56Luna.limits.contextWindow,
  reserveTokens: catalog.gpt56Luna.limits.contextWindow - catalog.gpt56Luna.limits.maxInputTokens,
  keepRecentTokens: 32_000,
}
