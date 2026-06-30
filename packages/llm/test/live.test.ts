import { describe, expect, test } from "bun:test"
import { Live } from "../src/index"

describe("Live provider options", () => {
  test("adapts a single OpenAI-compatible base URL for Anthropic's Effect AI client", () => {
    expect(Live.optionsFromEnv({ RIKA_BASE_URL: "http://127.0.0.1:8317/v1" })).toEqual({
      openai: {
        apiKeyEnv: "RIKA_API_KEY",
        apiUrl: "http://127.0.0.1:8317/v1",
      },
      anthropic: {
        apiKeyEnv: "RIKA_API_KEY",
        apiUrl: "http://127.0.0.1:8317",
      },
    })
  })

  test("keeps non-versioned base URLs unchanged for Anthropic", () => {
    expect(Live.stripTrailingV1("http://127.0.0.1:8317")).toBe("http://127.0.0.1:8317")
    expect(Live.stripTrailingV1("http://127.0.0.1:8317/v1/")).toBe("http://127.0.0.1:8317")
  })
})
