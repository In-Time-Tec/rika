import { describe, expect, test } from "bun:test"
import { ModelInfo, Tokens } from "../src/index"

describe("LLM model info", () => {
  test("returns known model context windows and output caps", () => {
    expect(ModelInfo.modelInfo("gpt-5.5")).toEqual({ context_window: 400_000, max_output_tokens: 128_000 })
    expect(ModelInfo.modelInfo("claude-opus-4-8")).toEqual({ context_window: 200_000, max_output_tokens: 64_000 })
    expect(ModelInfo.modelInfo("claude-sonnet-4-6")).toEqual({ context_window: 200_000, max_output_tokens: 64_000 })
  })

  test("returns conservative defaults for unknown models", () => {
    expect(ModelInfo.modelInfo("unknown-model")).toEqual({ context_window: 200_000, max_output_tokens: 32_000 })
  })

  test("allows an environment override for model context window", () => {
    expect(ModelInfo.modelInfo("gpt-5.5", { RIKA_MODEL_CONTEXT_WINDOW: "123456" })).toEqual({
      context_window: 123_456,
      max_output_tokens: 128_000,
    })
  })

  test("rejects present non-decimal model context window env values", () => {
    expect(() => ModelInfo.modelInfo("gpt-5.5", { RIKA_MODEL_CONTEXT_WINDOW: "1e3" })).toThrow(
      "Invalid RIKA_MODEL_CONTEXT_WINDOW 1e3",
    )
    expect(() => ModelInfo.modelInfo("gpt-5.5", { RIKA_MODEL_CONTEXT_WINDOW: "+5" })).toThrow(
      "Invalid RIKA_MODEL_CONTEXT_WINDOW +5",
    )
  })

  test("computes usable budget after reserved output tokens", () => {
    expect(ModelInfo.usableBudget({ context_window: 200_000, max_output_tokens: 32_000 })).toBe(180_000)
    expect(ModelInfo.usableBudget({ context_window: 200_000, max_output_tokens: 32_000 }, 8_000)).toBe(192_000)
  })
})

describe("LLM token estimation", () => {
  test("estimates tokens from characters", () => {
    expect(Tokens.estimateTokens("")).toBe(0)
    expect(Tokens.estimateTokens("abcd")).toBe(1)
    expect(Tokens.estimateTokens("abcde")).toBe(2)
  })

  test("estimates message tokens from JSON shape", () => {
    const messages = [{ role: "user" as const, content: "hello" }]
    expect(Tokens.estimateMessages(messages)).toBe(Tokens.estimateTokens(JSON.stringify(messages)))
  })
})
