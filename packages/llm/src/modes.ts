import { Config } from "@rika/core"
import { Schema } from "effect"
import * as Provider from "./provider"

export const ModeName = Config.Mode
export type ModeName = Config.Mode

export const ProfileName = Schema.Literals([
  "review",
  "search",
  "read_thread",
  "view_media",
  "oracle",
  "librarian",
]).annotate({
  identifier: "Rika.LLM.ProfileName",
})
export type ProfileName = typeof ProfileName.Type

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
  tool_policy: ToolPolicy,
  intent: CostLatencyIntent,
  temperature: Schema.optional(Schema.Number),
}).annotate({ identifier: "Rika.LLM.ModeConfig" })

export interface ProfileConfig extends Schema.Schema.Type<typeof ProfileConfig> {}
export const ProfileConfig = Schema.Struct({
  name: ProfileName,
  provider: Provider.ProviderName,
  model_preferences: Schema.Array(Provider.ModelId),
  reasoning_effort: Provider.ReasoningEffort,
  temperature: Schema.optional(Schema.Number),
}).annotate({ identifier: "Rika.LLM.ProfileConfig" })

export type RoutingConfig = ModeConfig | ProfileConfig

export const defaultModel = "gpt-5.5"
export const smartModel = "claude-opus-4-8"
export const sonnetModel = "claude-sonnet-4-6"

export const defaultModes: Record<ModeName, ModeConfig> = {
  rush: {
    name: "rush",
    provider: "openai",
    model_preferences: [defaultModel],
    reasoning_effort: "none",
    tool_policy: "minimal",
    intent: "lowest-latency",
  },
  smart: {
    name: "smart",
    provider: "anthropic",
    model_preferences: [smartModel],
    reasoning_effort: "max",
    tool_policy: "standard",
    intent: "balanced",
  },
  deep1: {
    name: "deep1",
    provider: "openai",
    model_preferences: [defaultModel],
    reasoning_effort: "medium",
    tool_policy: "autonomous",
    intent: "maximum-capability",
  },
  deep2: {
    name: "deep2",
    provider: "openai",
    model_preferences: [defaultModel],
    reasoning_effort: "high",
    tool_policy: "autonomous",
    intent: "maximum-capability",
  },
  deep3: {
    name: "deep3",
    provider: "openai",
    model_preferences: [defaultModel],
    reasoning_effort: "xhigh",
    tool_policy: "autonomous",
    intent: "maximum-capability",
  },
}

export const defaultProfiles: Record<ProfileName, ProfileConfig> = {
  review: {
    name: "review",
    provider: "openai",
    model_preferences: [defaultModel],
    reasoning_effort: "medium",
  },
  search: {
    name: "search",
    provider: "anthropic",
    model_preferences: [sonnetModel],
    reasoning_effort: "low",
  },
  read_thread: {
    name: "read_thread",
    provider: "anthropic",
    model_preferences: [sonnetModel],
    reasoning_effort: "low",
  },
  view_media: {
    name: "view_media",
    provider: "anthropic",
    model_preferences: [smartModel],
    reasoning_effort: "max",
  },
  oracle: {
    name: "oracle",
    provider: "openai",
    model_preferences: [defaultModel],
    reasoning_effort: "xhigh",
  },
  librarian: {
    name: "librarian",
    provider: "openai",
    model_preferences: [defaultModel],
    reasoning_effort: "high",
  },
}

export const get = (mode: ModeName): ModeConfig => defaultModes[mode]
export const getProfile = (profile: ProfileName): ProfileConfig => defaultProfiles[profile]

export const primaryModel = (config: Pick<RoutingConfig, "model_preferences">): Provider.ModelId =>
  config.model_preferences[0] ?? defaultModel
