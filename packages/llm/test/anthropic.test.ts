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

  test("keeps per-request model overrides outside the generated Anthropic enum", () => {
    const config = JSON.parse(
      JSON.stringify(Anthropic.requestConfigFromRikaRequest({ ...request, model: "claude-opus-4-8" })),
    )

    expect(config.model).toBe("claude-opus-4-8")
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

  test("keeps Anthropic max token defaults for direct JSON requests", () => {
    const original = HttpClientRequest.post("/v1/messages", {
      body: HttpClientRequest.bodyJsonUnsafe(HttpClientRequest.empty, {
        model: "claude-opus-4-8",
        max_tokens: 64000,
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      }).body,
    })
    const rewritten = Anthropic.stripMaxTokensFromRequest(original, { enabled: false })
    if (rewritten.body._tag !== "Uint8Array") throw new Error("Expected JSON body")
    const body = JSON.parse(new TextDecoder().decode(rewritten.body.body))

    expect(body).toEqual({
      model: "claude-opus-4-8",
      max_tokens: 64000,
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

  test("normalizes pretty JSON response model ids before Effect schema decoding", async () => {
    const response = HttpClientResponse.fromWeb(
      HttpClientRequest.post("/v1/messages"),
      new Response(
        JSON.stringify(
          {
            type: "message",
            model: "claude-opus-4-8",
            content: [{ type: "text", text: "source mentions claude-opus-4-8" }],
          },
          undefined,
          2,
        ),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    )
    const normalized = Anthropic.normalizeResponseModel(response)
    const text = await Effect.runPromise(normalized.text)
    const body = JSON.parse(text)

    expect(body.model).toBe("claude-opus-4-6")
    expect(body.content[0].text).toBe("source mentions claude-opus-4-8")
  })

  test("normalizes only the Anthropic message envelope model in SSE streams", async () => {
    const response = HttpClientResponse.fromWeb(
      HttpClientRequest.post("/v1/messages"),
      new Response(
        [
          'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-opus-4-8"}}',
          'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"source mentions claude-opus-4-8","model":"claude-opus-4-8"}}',
          "",
        ].join("\n\n"),
        {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        },
      ),
    )
    const normalized = Anthropic.normalizeResponseModel(response)
    const text = await Effect.runPromise(normalized.text)

    expect(text).toContain('"message":{"model":"claude-opus-4-6"}')
    expect(text).toContain('"text":"source mentions claude-opus-4-8"')
    expect(text).toContain(
      '"delta":{"type":"text_delta","text":"source mentions claude-opus-4-8","model":"claude-opus-4-8"}',
    )
  })
})
