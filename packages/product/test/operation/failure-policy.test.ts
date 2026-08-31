import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"
import { FailureCategory, modelFailurePresentation } from "../../src/operation/failure-policy"
import {
  classifyFailureMessage,
  executionFailureDetail,
  providerFailureMessage,
  turnFailure,
} from "../../src/operation/failure-message"

describe("failure policy", () => {
  it("classifies model failures from the structured Generalist event, never from prose", () => {
    const transient = modelFailurePresentation({ category: "rate-limit", classification: "transient" })
    expect(transient).toEqual({
      message: "The provider limited how often requests are accepted.",
      category: "rate-limit",
      retryable: true,
      retry: "automatic",
    })
    const terminal = modelFailurePresentation({ category: "authentication", classification: "terminal" })
    expect(terminal.retryable).toBe(false)
    expect(terminal.retry).toBe("none")
    expect(terminal.message).toBe("The provider rejected the configured credentials.")
    expect(terminal.message).not.toMatch(/try again|press enter|next/i)
  })

  it("classifies raw provider messages with one pattern table", () => {
    expect(
      classifyFailureMessage("effect/ai/AiError/AiError: OpenAiClient.createResponseStream: Rate Limit exceeded"),
    ).toMatchObject({ category: "rate-limit", retryable: true, retry: "automatic" })
    expect(classifyFailureMessage("AnthropicClient.createResponseStream: 429 Too Many Requests")).toMatchObject({
      category: "rate-limit",
      retryable: true,
    })
    expect(classifyFailureMessage("effect/ai/AiError/AiError: 429 Insufficient quota")).toMatchObject({
      category: "token-budget",
      retryable: false,
    })
    expect(classifyFailureMessage("SomeProvider.streamText: something unusual happened")).toBeUndefined()
    expect(classifyFailureMessage("")).toBeUndefined()
  })

  it("keeps failure detail messages readable and instruction-free", () => {
    expect(
      executionFailureDetail("effect/ai/AiError/AiError: OpenAiClient.createResponseStream: Rate Limit exceeded"),
    ).toBe("The provider rate-limited the request.")
    expect(executionFailureDetail("effect/ai/AiError/AiError: SomeProvider.streamText: odd")).toBe(
      "SomeProvider.streamText: odd",
    )
    expect(providerFailureMessage("effect/ai/AiError/AiError: connection refused")).toContain("connection")
  })

  it("reads the settled failure off projected units with its classification", () => {
    type Block =
      | { readonly _tag: "Entry"; readonly role: "user"; readonly text: string }
      | {
          readonly _tag: "Error"
          readonly title: string
          readonly detail: string
          readonly category: "rate-limit"
          readonly retryable: boolean
        }
    const unit = (block: Block) =>
      ({
        key: "k",
        turnId: "t",
        order: [{ sequence: 1, part: 0, key: "k" }],
        revision: 1,
        content: { _tag: "Block", block },
      }) as const
    const failure = turnFailure([
      unit({ _tag: "Entry", role: "user", text: "hi" }),
      unit({
        _tag: "Error",
        title: "The provider limited how often requests are accepted.",
        detail: "",
        category: "rate-limit",
        retryable: true,
      }),
    ])
    expect(failure).toEqual({
      message: "The provider limited how often requests are accepted.",
      category: "rate-limit",
      retryable: true,
    })
    expect(turnFailure([unit({ _tag: "Entry", role: "user", text: "hi" })])).toBeUndefined()
  })

  it("keeps the failure category union closed", () => {
    expect(Schema.is(FailureCategory)("rate-limit")).toBe(true)
    expect(Schema.is(FailureCategory)("operation")).toBe(true)
    expect(Schema.is(FailureCategory)("not-a-category")).toBe(false)
  })
})
