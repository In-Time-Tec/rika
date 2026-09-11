import * as BunHttpServer from "@effect/platform-bun/BunHttpServer"
import { Effect, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Json))

const modelResponse = (tool: boolean) => {
  const item = tool
    ? {
        type: "function_call",
        id: "fc_native",
        call_id: "call_native",
        name: "bash",
        arguments: encode({ command: "printf production-native > production-result.txt" }),
        status: "completed",
      }
    : {
        type: "message",
        id: "msg_done",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "The workspace file is ready.", annotations: [] }],
      }
  const response = {
    id: tool ? "resp_tool" : "resp_done",
    model: "gpt-6-astra",
    created_at: 1_788_940_800,
    output: [item],
    usage: {
      input_tokens: 1,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 1,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 2,
    },
  }
  const events: Array<Schema.Json> = [
    { type: "response.created", sequence_number: 0, response: { ...response, output: [] } },
    { type: "response.output_item.added", sequence_number: 1, output_index: 0, item },
  ]
  if (!tool)
    events.push({
      type: "response.output_text.delta",
      sequence_number: 2,
      output_index: 0,
      content_index: 0,
      item_id: item.id,
      delta: "The workspace file is ready.",
    })
  events.push(
    { type: "response.output_item.done", sequence_number: 3, output_index: 0, item },
    { type: "response.completed", sequence_number: 4, response },
  )
  return HttpServerResponse.text(events.map((event) => `data: ${encode(event)}\n\n`).join(""), {
    contentType: "text/event-stream",
  })
}

export const modelHttpFixture = Effect.gen(function* () {
  const requests: Array<string> = []
  const server = yield* BunHttpServer.make({ hostname: "127.0.0.1", port: 0 })
  if (server.address._tag !== "TcpAddress") return yield* Effect.die("Expected a local model HTTP listener")
  const url = `http://127.0.0.1:${server.address.port}/responses`
  yield* server.serve(
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      if (request.method !== "POST" || request.headers.authorization !== "Bearer test-only-model-key")
        return HttpServerResponse.empty({ status: 403 })
      requests.push(yield* request.text)
      return modelResponse(requests.length === 1)
    }),
  )
  const fetch: typeof globalThis.fetch = Object.assign(
    (_input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]) =>
      Bun.fetch(url, init),
    { preconnect: globalThis.fetch.preconnect },
  )
  return { requests, fetch }
})
