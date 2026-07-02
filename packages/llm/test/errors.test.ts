import { describe, expect, test } from "bun:test"
import { AiError } from "effect/unstable/ai"
import { Errors, Provider, Router } from "../src/index"

const openAiOverflow = AiError.make({
  module: "OpenAiLanguageModel",
  method: "streamText",
  reason: new AiError.InvalidRequestError({
    description:
      "This model's maximum context length is 128000 tokens. However, your messages resulted in 129000 tokens.",
    http: {
      request: {
        method: "POST",
        url: "https://api.openai.com/v1/responses",
        urlParams: [],
        headers: {},
        hash: undefined,
      },
      response: {
        status: 400,
        headers: {},
      },
    },
  }),
})

const anthropicOverflow = AiError.make({
  module: "AnthropicLanguageModel",
  method: "streamText",
  reason: new AiError.InvalidRequestError({
    description: "prompt is too long: 201000 tokens > 200000 maximum",
    http: {
      request: {
        method: "POST",
        url: "https://api.anthropic.com/v1/messages",
        urlParams: [],
        headers: {},
        hash: undefined,
      },
      response: {
        status: 400,
        headers: {},
      },
    },
  }),
})

describe("LLM Errors", () => {
  test("classifies provider context-window failures", () => {
    expect(Errors.isContextOverflow(openAiOverflow)).toBe(true)
    expect(Errors.isContextOverflow(anthropicOverflow)).toBe(true)
  })

  test("classifies router and nested provider error messages", () => {
    expect(Errors.isContextOverflow(new Router.RouterError({ message: "prompt is too long" }))).toBe(true)
    expect(
      Errors.isContextOverflow({
        error: {
          message: "token limit exceeded for requested model",
          type: "invalid_request_error",
        },
        status: 400,
      }),
    ).toBe(true)
  })

  test("classifies zero-progress length responses separately", () => {
    const zeroProgress: Provider.GenerateResponse = {
      provider: "openai",
      model: "test",
      content: "",
      finish_reason: "length",
    }
    const withContent: Provider.GenerateResponse = {
      provider: "openai",
      model: "test",
      content: "partial",
      finish_reason: "length",
    }
    const stopped: Provider.GenerateResponse = {
      provider: "openai",
      model: "test",
      content: "",
      finish_reason: "stop",
    }

    expect(Errors.isContextOverflow(zeroProgress)).toBe(true)
    expect(Errors.isZeroProgressLengthResponse(zeroProgress)).toBe(true)
    expect(Errors.isZeroProgressLengthResponse(withContent)).toBe(false)
    expect(Errors.isZeroProgressLengthResponse(stopped)).toBe(false)
  })

  test("does not classify unrelated invalid requests", () => {
    const invalidTemperature = AiError.make({
      module: "OpenAiLanguageModel",
      method: "streamText",
      reason: new AiError.InvalidRequestError({
        parameter: "temperature",
        constraint: "must be between 0 and 2",
      }),
    })

    expect(Errors.isContextOverflow(invalidTemperature)).toBe(false)
  })
})
