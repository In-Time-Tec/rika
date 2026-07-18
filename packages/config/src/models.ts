import type { Effort, ModelAlias } from "./config-contract"

const source = "https://models.dev"

export const catalog = {
  gpt56Luna: {
    source,
    id: "gpt-5.6-luna",
    limits: { contextWindow: 1_050_000, maxInputTokens: 922_000, maxOutputTokens: 128_000 },
    efforts: ["low", "medium", "high", "xhigh", "max"],
  },
  gpt56Terra: {
    source,
    id: "gpt-5.6-terra",
    limits: { contextWindow: 1_050_000, maxInputTokens: 922_000, maxOutputTokens: 128_000 },
    efforts: ["low", "medium", "high", "xhigh", "max"],
  },
  gpt56Sol: {
    source,
    id: "gpt-5.6-sol",
    limits: { contextWindow: 1_050_000, maxInputTokens: 922_000, maxOutputTokens: 128_000 },
    efforts: ["low", "medium", "high", "xhigh", "max"],
  },
  gpt55: {
    source,
    id: "gpt-5.5",
    limits: { contextWindow: 1_050_000, maxInputTokens: 922_000, maxOutputTokens: 128_000 },
    efforts: ["low", "medium", "high", "xhigh"],
  },
  claudeFable5: {
    source,
    id: "claude-fable-5",
    limits: { contextWindow: 1_000_000, maxInputTokens: 872_000, maxOutputTokens: 128_000 },
    efforts: ["low", "medium", "high", "xhigh", "max"],
  },
  claudeOpus48: {
    source,
    id: "claude-opus-4-8",
    limits: { contextWindow: 1_000_000, maxInputTokens: 872_000, maxOutputTokens: 128_000 },
    efforts: ["low", "medium", "high", "xhigh", "max"],
  },
} as const

type CatalogModel = (typeof catalog)[keyof typeof catalog]

const limits = (model: CatalogModel, keepRecentTokens: number) => ({
  maxInputTokens: model.limits.maxInputTokens,
  maxOutputTokens: model.limits.maxOutputTokens,
  keepRecentTokens,
})

const gptVariants = (model: CatalogModel) =>
  Object.fromEntries(
    model.efforts.map((effort) => [
      effort,
      {
        normal: { options: { reasoning: { effort, summary: "auto" } } },
        fast: {
          options: {
            reasoning: { effort, summary: "auto" },
            service_tier: "priority",
          },
        },
      },
    ]),
  ) as ModelAlias["variants"]

const claudeVariants = (model: CatalogModel) =>
  Object.fromEntries(
    model.efforts.map((effort) => [effort, { normal: { options: { output_config: { effort } } } }]),
  ) as ModelAlias["variants"]

const gpt = (model: CatalogModel): ModelAlias => ({
  provider: "openai",
  candidates: [model.id],
  limits: limits(model, 32_000),
  variants: gptVariants(model),
})

const claude = (model: CatalogModel, candidates: ReadonlyArray<string>): ModelAlias => ({
  provider: "anthropic",
  candidates,
  limits: limits(model, 64_000),
  variants: claudeVariants(model),
})

export const defaults = {
  luna: gpt(catalog.gpt56Luna),
  terra: gpt(catalog.gpt56Terra),
  sol: gpt(catalog.gpt56Sol),
  review: gpt(catalog.gpt55),
  fable: claude(catalog.claudeFable5, [catalog.claudeFable5.id, catalog.claudeOpus48.id]),
  opus: claude(catalog.claudeOpus48, [catalog.claudeOpus48.id]),
} satisfies Readonly<Record<string, ModelAlias>>

export const defaultCompaction = {
  contextWindow: catalog.gpt56Luna.limits.contextWindow,
  reserveTokens: catalog.gpt56Luna.limits.maxOutputTokens,
  keepRecentTokens: 32_000,
}

export const supportedEfforts = ["low", "medium", "high", "xhigh", "max"] as const satisfies ReadonlyArray<Effort>
