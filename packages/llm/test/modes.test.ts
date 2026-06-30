import { describe, expect, test } from "bun:test"
import { Modes } from "../src/index"

describe("LLM modes", () => {
  test("defines rush, smart, and deep tiers as routing data", () => {
    expect(Modes.defaultModes.rush).toMatchObject({
      name: "rush",
      provider: "openai",
      reasoning_effort: "none",
      tool_policy: "minimal",
      intent: "lowest-latency",
    })
    expect(Modes.defaultModes.smart).toMatchObject({
      name: "smart",
      provider: "anthropic",
      model_preferences: ["claude-opus-4-8"],
      reasoning_effort: "max",
      tool_policy: "standard",
      intent: "balanced",
    })
    expect(Modes.defaultModes.deep1).toMatchObject({
      name: "deep1",
      provider: "openai",
      model_preferences: ["gpt-5.5"],
      reasoning_effort: "medium",
      tool_policy: "autonomous",
      intent: "maximum-capability",
    })
    expect(Modes.defaultModes.deep2).toMatchObject({
      name: "deep2",
      provider: "openai",
      reasoning_effort: "high",
      tool_policy: "autonomous",
      intent: "maximum-capability",
    })
    expect(Modes.defaultModes.deep3).toMatchObject({
      name: "deep3",
      provider: "openai",
      reasoning_effort: "xhigh",
      tool_policy: "autonomous",
      intent: "maximum-capability",
    })
  })

  test("defines specialized model profiles", () => {
    expect(Modes.defaultProfiles.search).toMatchObject({
      provider: "anthropic",
      model_preferences: ["claude-sonnet-4-6"],
      reasoning_effort: "low",
    })
    expect(Modes.defaultProfiles.oracle).toMatchObject({
      provider: "openai",
      model_preferences: ["gpt-5.5"],
      reasoning_effort: "xhigh",
    })
  })

  test("chooses the first model preference as the primary model", () => {
    expect(Modes.primaryModel({ ...Modes.defaultModes.rush, model_preferences: ["fast", "fallback"] })).toBe("fast")
    expect(Modes.primaryModel({ ...Modes.defaultModes.rush, model_preferences: [] })).toBe(Modes.defaultModel)
  })
})
