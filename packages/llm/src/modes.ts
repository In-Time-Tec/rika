import { Config } from "@rika/core"
import { Schema } from "effect"
import * as Provider from "./provider"

export const ModeName = Config.Mode
export type ModeName = Config.Mode

export const ToolPolicy = Schema.Literals(["minimal", "standard", "autonomous"]).annotate({
  identifier: "Rika.LLM.ToolPolicy",
})
export type ToolPolicy = typeof ToolPolicy.Type

export const CostLatencyIntent = Schema.Literals(["lowest-latency", "balanced", "maximum-capability"]).annotate({
  identifier: "Rika.LLM.CostLatencyIntent",
})
export type CostLatencyIntent = typeof CostLatencyIntent.Type

export interface ModeConfig extends Schema.Schema.Type<typeof ModeConfig> {}
export const ModeConfig = Schema.Struct({
  name: ModeName,
  provider: Provider.ProviderName,
  model_preferences: Schema.Array(Provider.ModelId),
  reasoning_effort: Provider.ReasoningEffort,
  max_output_tokens: Schema.Int,
  tool_policy: ToolPolicy,
  intent: CostLatencyIntent,
  temperature: Schema.optional(Schema.Number),
}).annotate({ identifier: "Rika.LLM.ModeConfig" })

export const defaultModel = "gpt-5.5"

export const defaultModes: Record<ModeName, ModeConfig> = {
  rush: {
    name: "rush",
    provider: "openai",
    model_preferences: [defaultModel],
    reasoning_effort: "none",
    max_output_tokens: 4_096,
    tool_policy: "minimal",
    intent: "lowest-latency",
  },
  smart: {
    name: "smart",
    provider: "openai",
    model_preferences: [defaultModel],
    reasoning_effort: "medium",
    max_output_tokens: 12_000,
    tool_policy: "standard",
    intent: "balanced",
  },
  deep: {
    name: "deep",
    provider: "openai",
    model_preferences: [defaultModel],
    reasoning_effort: "high",
    max_output_tokens: 24_000,
    tool_policy: "autonomous",
    intent: "maximum-capability",
  },
}

export const get = (mode: ModeName): ModeConfig => defaultModes[mode]

export const primaryModel = (mode: ModeConfig): Provider.ModelId => mode.model_preferences[0] ?? defaultModel
