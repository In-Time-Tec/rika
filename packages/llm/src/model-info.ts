import { EnvConfig } from "@rika/core/env-config"
import { Schema } from "effect"

export interface ModelInfo extends Schema.Schema.Type<typeof ModelInfo> {}
export const ModelInfo = Schema.Struct({
  context_window: Schema.Int,
  max_output_tokens: Schema.Int,
}).annotate({ identifier: "Rika.LLM.ModelInfo" })

export type Env = Readonly<Record<string, string | undefined>>

const defaultInfo: ModelInfo = {
  context_window: 200_000,
  max_output_tokens: 32_000,
}

const knownModels: Readonly<Record<string, ModelInfo>> = {
  "gpt-5.5": {
    context_window: 400_000,
    max_output_tokens: 128_000,
  },
  "claude-opus-4-8": {
    context_window: 200_000,
    max_output_tokens: 64_000,
  },
  "claude-sonnet-4-6": {
    context_window: 200_000,
    max_output_tokens: 64_000,
  },
}

export const modelInfo = (model: string, env: Env = process.env): ModelInfo => {
  const base = knownModels[model] ?? defaultInfo
  const override = contextWindowOverride(env)
  return override === undefined ? base : { ...base, context_window: override }
}

export const usableBudget = (info: ModelInfo, reserved?: number): number =>
  info.context_window - (reserved ?? Math.min(20_000, info.max_output_tokens))

const contextWindowOverride = (env: Env): number | undefined => {
  const provider = EnvConfig.providerFromEnv(env)
  const parsed = EnvConfig.optionalDecimalIntegerSync(provider, "RIKA_MODEL_CONTEXT_WINDOW", {
    minimum: 1,
    allowLeadingZero: false,
  })
  return parsed !== undefined && parsed > 0 ? parsed : undefined
}
