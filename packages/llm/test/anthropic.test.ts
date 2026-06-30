import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { Anthropic, Provider } from "../src/index"

const request: Provider.GenerateRequest = {
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  messages: [{ role: "user", content: "Hello" }],
  reasoning_effort: "max",
  temperature: 0.2,
}

describe("Anthropic Effect AI layer", () => {
  test("maps Rika routing data to Effect AI Anthropic request config", () => {
    const config = JSON.parse(JSON.stringify(Anthropic.requestConfigFromRikaRequest(request)))

    expect(config).toEqual({
      model: "claude-sonnet-4-6",
      temperature: 0.2,
      output_config: { effort: "high" },
    })
  })

  test("strips Effect AI max token defaults from Anthropic JSON requests", () => {
    const original = HttpClientRequest.post("/v1/messages", {
      body: HttpClientRequest.bodyJsonUnsafe(HttpClientRequest.empty, {
        model: "claude-opus-4-8",
        max_tokens: 64000,
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      }).body,
    })
    const rewritten = Anthropic.stripMaxTokensFromRequest(original)
    if (rewritten.body._tag !== "Uint8Array") throw new Error("Expected JSON body")
    const body = JSON.parse(new TextDecoder().decode(rewritten.body.body))

    expect(body).toEqual({
      model: "claude-opus-4-8",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    })
  })

  test("normalizes new Anthropic response model ids before Effect schema decoding", async () => {
    const response = HttpClientResponse.fromWeb(
      HttpClientRequest.post("/v1/messages"),
      new Response('event: message_start\ndata: {"type":"message_start","message":{"model":"claude-opus-4-8"}}\n\n', {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    )
    const normalized = Anthropic.normalizeResponseModel(response)
    const text = await Effect.runPromise(normalized.text)

    expect(text).toContain('"model":"claude-opus-4-6"')
    expect(text).not.toContain("claude-opus-4-8")
  })
})
