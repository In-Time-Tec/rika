import { describe, expect, test } from "bun:test"
import { OpenAi, Provider } from "../src/index"

const request: Provider.GenerateRequest = {
  provider: "openai",
  model: "gpt-test",
  messages: [{ role: "user", content: "Hello" }],
  reasoning_effort: "low",
  max_output_tokens: 123,
  temperature: 0.2,
  metadata: { thread_id: "T-1" },
}

describe("OpenAI Effect AI layer", () => {
  test("maps Rika routing data to Effect AI OpenAI request config", () => {
    expect(OpenAi.requestConfigFromRikaRequest(request)).toEqual({
      model: "gpt-test",
      store: false,
      temperature: 0.2,
      max_output_tokens: 123,
      metadata: { thread_id: "T-1" },
      reasoning: { effort: "low" },
    })
  })

  test("keeps OpenAI credentials behind the live layer options", () => {
    expect(OpenAi.defaultApiKeyEnv).toBe("OPENAI_API_KEY")
    expect(OpenAi.providerName).toBe("openai")
  })
})
