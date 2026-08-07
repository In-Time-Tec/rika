import { describe, expect, it } from "@effect/vitest"
import { executionFailureDetail, modelFailurePresentation } from "../src/failure-presentation"

describe("failure presentation", () => {
  it("maps model failure categories to friendly titles and actions", () => {
    const rateLimit = modelFailurePresentation({ category: "rate-limit", classification: "terminal" })
    expect(rateLimit.title).toBe("Model rate limit reached")
    expect(rateLimit.detail).toContain("provider limited")
    expect(rateLimit.recovery).toContain("cannot succeed")

    const transient = modelFailurePresentation({ category: "provider-response", classification: "transient" })
    expect(transient.title).toBe("The model provider returned an error")
    expect(transient.recovery).toContain("temporary")
  })

  it("cleans internal prefixes and maps provider phrases to readable detail", () => {
    expect(
      executionFailureDetail("effect/ai/AiError/AiError: OpenAiClient.createResponseStream: Rate Limit exceeded"),
    ).toBe("The model provider rate-limited the request. Wait a moment, then try again.")
    expect(
      executionFailureDetail(
        "effect/ai/AiError/AiError: OpenAiLanguageModel.streamText: Internal provider error: Our servers are currently overloaded. Please try again later.",
      ),
    ).toBe("The model provider is temporarily overloaded. Wait a moment, then try again.")
  })

  it("keeps unknown messages readable instead of replacing them", () => {
    const detail = executionFailureDetail(
      "effect/ai/AiError/AiError: SomeProvider.streamText: something unusual happened",
    )
    expect(detail).toBe("SomeProvider.streamText: something unusual happened")
    expect(detail).not.toContain("effect/ai/AiError/AiError:")
  })
})
