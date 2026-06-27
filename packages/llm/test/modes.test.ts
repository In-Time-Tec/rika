import { describe, expect, test } from "bun:test"
import { Modes } from "../src/index"

describe("LLM modes", () => {
  test("defines rush, smart, and deep as routing data", () => {
    expect(Modes.defaultModes.rush).toMatchObject({
      name: "rush",
      provider: "openai",
      reasoning_effort: "none",
      tool_policy: "minimal",
      intent: "lowest-latency",
    })
    expect(Modes.defaultModes.smart).toMatchObject({
      name: "smart",
      provider: "openai",
      reasoning_effort: "medium",
      tool_policy: "standard",
      intent: "balanced",
    })
    expect(Modes.defaultModes.deep).toMatchObject({
      name: "deep",
      provider: "openai",
      reasoning_effort: "high",
      tool_policy: "autonomous",
      intent: "maximum-capability",
    })
  })

  test("chooses the first model preference as the primary model", () => {
    expect(Modes.primaryModel({ ...Modes.defaultModes.rush, model_preferences: ["fast", "fallback"] })).toBe("fast")
    expect(Modes.primaryModel({ ...Modes.defaultModes.rush, model_preferences: [] })).toBe(Modes.defaultModel)
  })
})
