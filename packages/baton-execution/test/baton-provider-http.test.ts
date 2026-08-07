import { describe, expect, it } from "@effect/vitest"
import { Effect, Option, Schema } from "effect"
import { Response as AiResponse } from "effect/unstable/ai"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { withDecodableRequestDetails } from "../src/baton-provider-http"

const capturing = (seen: Array<HttpClientRequest.HttpClientRequest>) =>
  HttpClient.make((request) => {
    seen.push(request)
    return Effect.succeed(HttpClientResponse.fromWeb(request, new globalThis.Response("{}")))
  })

const capture = (request: HttpClientRequest.HttpClientRequest) =>
  Effect.gen(function* () {
    const seen: Array<HttpClientRequest.HttpClientRequest> = []
    yield* withDecodableRequestDetails(capturing(seen)).execute(request)
    return seen[0]!
  })

const persistedDetails = (request: HttpClientRequest.HttpClientRequest) => {
  const details: Record<string, unknown> = {
    method: request.method,
    url: request.url,
    urlParams: Array.from(request.urlParams),
    hash: Option.getOrUndefined(request.hash),
    headers: {},
  }
  return Object.fromEntries(Object.entries(details).filter(([, value]) => value !== undefined))
}

const decodeDetails = Schema.decodeUnknownEffect(AiResponse.HttpRequestDetails)

describe("provider http client", () => {
  it.effect("carries a fragment so the recorded hash is never undefined", () =>
    Effect.gen(function* () {
      const request = yield* capture(HttpClientRequest.post("https://provider.test/v1/responses"))

      expect(Option.getOrUndefined(request.hash)).toBe("")
    }),
  )

  it.effect("keeps request details decodable once undefined keys are dropped", () =>
    Effect.gen(function* () {
      const request = yield* capture(HttpClientRequest.post("https://provider.test/v1/responses"))

      const details = persistedDetails(request)
      const decoded = yield* decodeDetails(details)

      expect(decoded.method).toBe("POST")
    }),
  )

  it.effect("rejects details recorded without the fragment, proving the guard is load bearing", () =>
    Effect.gen(function* () {
      const bare = persistedDetails(HttpClientRequest.post("https://provider.test/v1/responses"))
      const decoded = yield* Effect.exit(decodeDetails(bare))

      expect(decoded._tag).toBe("Failure")
    }),
  )

  it.effect("leaves the method and url untouched", () =>
    Effect.gen(function* () {
      const request = yield* capture(HttpClientRequest.post("https://provider.test/v1/responses"))

      expect([request.method, request.url]).toEqual(["POST", "https://provider.test/v1/responses"])
    }),
  )

  it.effect("preserves a fragment a caller already set", () =>
    Effect.gen(function* () {
      const request = yield* capture(
        HttpClientRequest.post("https://provider.test/v1/responses").pipe(HttpClientRequest.setHash("frag")),
      )

      expect(Option.getOrUndefined(request.hash)).toBe("frag")
    }),
  )
})
